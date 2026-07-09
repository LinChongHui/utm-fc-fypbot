"""
AI RAG Chatbot Backend (FastAPI + Chroma + Ollama + Firestore Live Sync)
========================================================================

Features:
---------
✅ Stream approved records directly from Cloud Firestore (psm_sections)
✅ Strict Admin Panel Guardrails (Only loads chunks where approved == True)
✅ Automatic human-readable Snapshot generation (ai_knowledge_base_snapshot.txt)
✅ Build Chroma Vector Database dynamically
✅ Use Ollama embeddings (nomic-embed-text)
✅ Use Llama 3.2 for answering
✅ Use Llama 3.2 Vision / LLaVA for image understanding from picture_links
✅ FastAPI backend endpoints
✅ Clean short answers with strict citation context constraints
✅ Vision image description injection into RAG context pipeline
✅ Safe Chroma DB release before rebuild (fixes Windows file lock)
✅ LLM-Driven Multi-Query Expansion (Method 1: Dynamic campus synonym rewriting)
✅ Hybrid Substring Matching Fallback for Content-Poor / Brief Queries
"""

import os
import re
import gc
import base64
from datetime import datetime
import time
import ollama

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import firebase_admin
from firebase_admin import credentials, firestore

from langchain_community.vectorstores import Chroma
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings, ChatOllama
from langchain_core.documents import Document

import subprocess
import asyncio
import hashlib
import json
import shutil
from fastapi.responses import StreamingResponse

import sys
sys.stdout.reconfigure(encoding='utf-8')


# ─────────────────────────────────────────────────────────────
# FASTAPI CONFIGURATION
# ─────────────────────────────────────────────────────────────

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# FIREBASE & FIRESTORE SYNCHRONIZATION INITIALIZATION
# ─────────────────────────────────────────────────────────────

def init_firestore_client():
    """Initializes the admin SDK using your service account credentials file."""
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()


# ─────────────────────────────────────────────────────────────
# CONVERT FIRESTORE RECORDS TO LANGCHAIN DOCUMENTS + SNAPSHOT LOGGING
# ─────────────────────────────────────────────────────────────

def load_approved_knowledge_base():
    """Queries psm_sections from Firestore, pulling ONLY manually verified sections."""
    try:
        db = init_firestore_client()
        print("🛰️ Connecting to Firestore 'psm_sections' collection...")

        docs_ref = db.collection("psm_sections").where(
            filter=firestore.FieldFilter("approved", "==", True)
        )
        docs = docs_ref.stream()

        langchain_documents = []
        count = 0

        snapshot_filename = "ai_knowledge_base_snapshot.txt"

        with open(snapshot_filename, "w", encoding="utf-8") as snapshot_file:
            snapshot_file.write("===============================================================\n")
            snapshot_file.write("🤖 AUTOMATED AI AGENT KNOWLEDGE BASE SNAPSHOT REPORT\n")
            snapshot_file.write(f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            snapshot_file.write("===============================================================\n\n")
            snapshot_file.write("This file displays exactly what text fragments and metadata layout\n")
            snapshot_file.write("your local vector store indexer converts into numerical embeddings.\n\n")

            for doc in docs:
                data = doc.to_dict()

                page_title         = data.get("page_title", "Untitled Page").strip()
                heading            = data.get("heading", "General Information").strip()
                content            = data.get("content", "").strip()
                page_url           = data.get("page_url", "")
                path_str           = data.get("path", "")
                doc_links_list     = data.get("doc_links", [])
                picture_links_list = data.get("picture_links", [])

                doc_links_str     = ", ".join(doc_links_list)     if isinstance(doc_links_list, list) else str(doc_links_list)
                picture_links_str = ", ".join(picture_links_list) if isinstance(picture_links_list, list) else str(picture_links_list)

                if len(content) < 30:
                    continue

                count += 1

                formatted_page_content = (
                    f"Document Source Title: {page_title}\n"
                    f"Section Subheading Anchor: {heading}\n"
                    f"Source Citation URL: {page_url}\n"
                    f"Verified Context:\n{content}"
                )

                snapshot_file.write(f"--- [VECTORIZED CHUNK #{count}] (Firestore Document ID: {doc.id}) ---\n")
                snapshot_file.write(f"{formatted_page_content}\n")
                if picture_links_str:
                    snapshot_file.write(f"📷 Picture Links: {picture_links_str}\n")
                snapshot_file.write("-" * 60 + "\n\n")

                metadata = {
                    "id":                     doc.id,
                    "category":               "verified_kb_node",
                    "source":                 page_url,
                    "path":                   path_str,
                    "title":                  page_title,
                    "heading":                heading,
                    "downloadable_documents": doc_links_str,
                    "visual_attachments":     picture_links_str,
                    "ingested_at":            datetime.now().isoformat(),
                }

                langchain_documents.append(
                    Document(page_content=formatted_page_content, metadata=metadata)
                )

        print(f"✅ Successfully retrieved and mapped {count} approved sections from Firestore!")
        print(f"📝 Human-readable snapshot written to: '{snapshot_filename}'")
        return langchain_documents

    except Exception as e:
        print(f"❌ Error communicating with Firestore: {str(e)}")
        print("⚠️  Falling back to empty set. Ensure service account key file is valid.")
        return []


# ─────────────────────────────────────────────────────────────
# PREPARE & CHUNK DOCUMENTS
# ─────────────────────────────────────────────────────────────

print("📦 Preparing structured knowledge blocks for vectorizing...")
raw_docs = load_approved_knowledge_base()

splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=80,
    length_function=len,
)

docs = splitter.split_documents(raw_docs)
print(f"✅ Total chunk segments after text split: {len(docs)}")


# ─────────────────────────────────────────────────────────────
# SMART DIFF: HASH-BASED CHANGE DETECTION
# ─────────────────────────────────────────────────────────────

DB_PATH   = "./chroma_db_local"
HASH_FILE = "./chroma_db_local/.kb_fingerprint"

def reload_vectorstore(retries=5, delay=2):
    """Recreate the Chroma client from scratch after a DB rebuild."""
    global vectorstore  # or however you store it in main.py

    for attempt in range(1, retries + 1):
        try:
            # ✅ Step 1: Fully destroy the old client
            try:
                del vectorstore
            except Exception:
                pass
            gc.collect()

            # ✅ Step 2: Wait briefly for filesystem to settle
            time.sleep(1)

            # ✅ Step 3: Recreate from scratch — don't reuse old object
            embeddings = OllamaEmbeddings(model="nomic-embed-text")
            vectorstore = Chroma(
                persist_directory=DB_PATH,
                embedding_function=embeddings,
                collection_name="psm_utm_kb",
            )

            # ✅ Step 4: Test the connection
            vectorstore.get()  # triggers actual DB access
            print("✅ Vectorstore reloaded successfully.")
            return vectorstore

        except Exception as e:
            print(f"⏳ Reload attempt {attempt}/{retries} failed — retrying in {delay}s... ({e})")
            time.sleep(delay)

    raise RuntimeError("❌ Vectorstore reload failed after all attempts.")

def compute_kb_fingerprint() -> str:
    try:
        db = init_firestore_client()
        docs_ref = db.collection("psm_sections").where(
            filter=firestore.FieldFilter("approved", "==", True)
        )
        docs = docs_ref.stream()

        fingerprint_entries = []
        for doc in docs:
            data = doc.to_dict()
            timestamp = (
                str(data.get("updatedAt", ""))
                or str(data.get("scraped_at", ""))
                or ""
            )
            fingerprint_entries.append(f"{doc.id}:{timestamp}")

        fingerprint_entries.sort()
        raw = json.dumps(fingerprint_entries, ensure_ascii=False)
        fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()

        print(f"🔑 KB Fingerprint computed: {fingerprint[:16]}... ({len(fingerprint_entries)} approved docs)")
        return fingerprint

    except Exception as e:
        print(f"⚠️  Could not compute fingerprint: {e}")
        return ""


def load_saved_fingerprint() -> str:
    try:
        if os.path.exists(HASH_FILE):
            with open(HASH_FILE, "r") as f:
                return f.read().strip()
    except Exception:
        pass
    return ""


def save_fingerprint(fingerprint: str):
    try:
        os.makedirs(os.path.dirname(HASH_FILE), exist_ok=True)
        with open(HASH_FILE, "w") as f:
            f.write(fingerprint)
        print(f"💾 Fingerprint saved: {fingerprint[:16]}...")
    except Exception as e:
        print(f"⚠️  Could not save fingerprint: {e}")


# ─────────────────────────────────────────────────────────────
# CHROMA VECTORSTORE — GLOBAL HANDLE + LIFECYCLE MANAGEMENT
# ─────────────────────────────────────────────────────────────

_vectorstore: Chroma | None = None


def clear_chroma_system_cache():
    """Clear Chroma's per-process client cache before reconnecting to a rebuilt DB."""
    try:
        from chromadb.api.client import SharedSystemClient
        SharedSystemClient.clear_system_cache()
        print("Chroma system cache cleared.")
    except Exception as e:
        print(f"Could not clear Chroma system cache: {e}")


def release_vectorstore():
    """
    Explicitly close the ChromaDB client and release all file handles.
    MUST be called before any shutil.rmtree() on DB_PATH, otherwise
    Windows raises PermissionError [WinError 32].
    """
    global _vectorstore
    if _vectorstore is not None:
        try:
            _vectorstore._client._system.stop()
            print("🔓 Chroma client released.")
        except Exception as e:
            print(f"⚠️  Could not cleanly stop Chroma client: {e}")
        _vectorstore = None
    clear_chroma_system_cache()
    gc.collect()


def get_vectorstore() -> Chroma | None:
    """Returns the current global vectorstore handle (may be None if not built yet)."""
    return _vectorstore


def set_vectorstore(vs: Chroma | None):
    """Sets the global vectorstore handle."""
    global _vectorstore
    _vectorstore = vs


def build_vectorstore_from_docs(documents: list) -> Chroma | None:
    """
    Wipes the old DB, batches documents into Chroma, saves fingerprint.
    Returns the new vectorstore, or None if documents list is empty.
    """
    if not documents:
        print("⚠️  No approved docs to embed — skipping DB creation.")
        return None

    BATCH_SIZE = 50
    vs = None

    for i in range(0, len(documents), BATCH_SIZE):
        batch = documents[i:i + BATCH_SIZE]
        if vs is None:
            vs = Chroma.from_documents(
                documents=batch,
                embedding=embeddings,
                persist_directory=DB_PATH,
                collection_name="psm_utm_kb",
            )
        else:
            vs.add_documents(batch)
        print(f"  ✅ Embedded batch {i // BATCH_SIZE + 1} "
              f"({min(i + BATCH_SIZE, len(documents))}/{len(documents)} segments)")

    return vs


def wipe_chroma_db(retries: int = 5, delay: int = 2):
    """
    Deletes the Chroma DB folder safely.
    Retries on Windows PermissionError in case of lingering handles.
    Always call release_vectorstore() before this.
    """
    import time
    if not os.path.exists(DB_PATH):
        return
    for attempt in range(1, retries + 1):
        try:
            shutil.rmtree(DB_PATH)
            print("🗑️  Old Chroma DB wiped.")
            return
        except PermissionError as e:
            if attempt < retries:
                print(f"⚠️  DB still locked — retrying in {delay}s (attempt {attempt}/{retries})...")
                gc.collect()
                time.sleep(delay)
            else:
                raise RuntimeError(
                    f"\n❌ Cannot delete '{DB_PATH}' after {retries} attempts.\n"
                    f"   Kill remaining python processes:   Get-Process python | Stop-Process -Force\n"
                    f"   Original error: {e}"
                )


# ─────────────────────────────────────────────────────────────
# OLLAMA EMBEDDINGS (loaded once, reused everywhere)
# ─────────────────────────────────────────────────────────────

print("🧠 Loading embedding model (nomic-embed-text)...")
embeddings = OllamaEmbeddings(model="nomic-embed-text")


# ─────────────────────────────────────────────────────────────
# STARTUP: BUILD OR REUSE CHROMA DB
# ─────────────────────────────────────────────────────────────

current_fingerprint = compute_kb_fingerprint()
saved_fingerprint   = load_saved_fingerprint()

needs_rebuild = (
    not os.path.exists(DB_PATH)
    or current_fingerprint == ""
    or current_fingerprint != saved_fingerprint
)

if needs_rebuild and current_fingerprint != "":
    print("🔄 Change detected — rebuilding Chroma vector database...")
    release_vectorstore()   # safe no-op on first startup
    wipe_chroma_db()
    vs = build_vectorstore_from_docs(docs)
    set_vectorstore(vs)
    if vs:
        save_fingerprint(current_fingerprint)
        print("✅ Vector database rebuilt and fingerprint updated.")
else:
    if current_fingerprint == saved_fingerprint:
        print("✅ No Firestore changes detected — reusing existing Chroma DB.")
    print("📂 Linking existing Chroma vector store...")
    set_vectorstore(Chroma(
        persist_directory=DB_PATH,
        embedding_function=embeddings,
        collection_name="psm_utm_kb",
    ))
    print("✅ Vector store linked successfully.")


# ─────────────────────────────────────────────────────────────
# SHARED: Stream a subprocess line-by-line as Server-Sent Events
# ─────────────────────────────────────────────────────────────

async def stream_subprocess(cmd: list, cwd: str = None):
    """
    Runs a subprocess and yields each stdout/stderr line as SSE.
    Forces UTF-8 encoding on Windows to handle emoji in print() calls.
    """
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    force_rebuild = (
        current_fingerprint
        and current_fingerprint == saved_fingerprint
        and os.path.exists(DB_PATH)
        and (get_vectorstore() is None or retriever is None)
    )
    if force_rebuild:
        env["FORCE_REBUILD"] = "1"

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd,
        env=env,
    )

    async def generate():
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                yield f"data: {text}\n\n"

        await process.wait()
        exit_code = process.returncode
        if exit_code == 0:
            yield "data: ✅ Process completed successfully.\n\n"
        else:
            yield f"data: ❌ Process exited with code {exit_code}.\n\n"
        yield "data: __DONE__\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ─────────────────────────────────────────────────────────────
# ENDPOINT: /run-rebuild
# ─────────────────────────────────────────────────────────────
 
@app.post("/run-rebuild")
async def run_rebuild():
    # Release main.py's own handle on the OLD DB before rebuild starts.
    # This is critical on Windows — rebuild_db.py needs to move the old
    # folder, but it can't if main.py still holds file locks on it.
    release_vectorstore()
 
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
 
    process = await asyncio.create_subprocess_exec(
        "python", "-u", "rebuild_db.py",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
 
    async def generate():
        # Stream all output from rebuild_db.py line by line
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                yield f"data: {text}\n\n"
 
        await process.wait()
        exit_code = process.returncode
 
        if exit_code == 0:
            # ── Give the OS time to settle after the folder swap ──────────
            yield "data: ⏳ Waiting for DB swap to settle on disk...\n\n"
            await asyncio.sleep(4)
 
            # ── Confirm the DB folder exists after swap ───────────────────
            if not os.path.exists(DB_PATH):
                yield "data: ❌ DB folder missing after rebuild — something went wrong.\n\n"
                yield "data: __DONE__\n\n"
                return
 
            # ── Wait until chroma.sqlite3 file actually exists ────────────
            # The folder can exist but the SQLite file may still be mid-write.
            # Connecting before it's ready causes "default_tenant" error.
            sqlite_path = os.path.join(DB_PATH, "chroma.sqlite3")
            yield "data: 🔍 Verifying chroma.sqlite3 is ready...\n\n"
            for _ in range(20):
                if os.path.exists(sqlite_path):
                    break
                await asyncio.sleep(1)
            else:
                yield "data: ❌ chroma.sqlite3 never appeared — rebuild may have failed silently.\n\n"
                yield "data: __DONE__\n\n"
                return
 
            yield "data: ✅ SQLite DB file confirmed on disk.\n\n"
 
            # ── Clear the Chroma system cache before reconnecting ─────────
            # Without this, Chroma may reuse a stale in-process client
            # that points to the old (now deleted) DB path.
            try:
                from chromadb.api.client import SharedSystemClient
                SharedSystemClient.clear_system_cache()
                yield "data: 🧹 Chroma system cache cleared.\n\n"
            except Exception as cache_err:
                yield f"data: ⚠️  Cache clear skipped: {cache_err}\n\n"
 
            # ── Retry connecting to the freshly swapped DB ────────────────
            max_attempts = 5
            for attempt in range(1, max_attempts + 1):
                try:
                    # Always sleep before connecting — gives Chroma tenant
                    # initialisation time to complete its internal SQLite writes
                    await asyncio.sleep(3)
 
                    new_vs = Chroma(
                        persist_directory=DB_PATH,
                        embedding_function=embeddings,
                        collection_name="psm_utm_kb",
                    )
 
                    count = new_vs._collection.count()
                    yield f"data: 📊 Collection verified: {count} vectors loaded.\n\n"
 
                    set_vectorstore(new_vs)
 
                    global retriever
                    retriever = new_vs.as_retriever(
                        search_type="mmr",
                        search_kwargs={"k": 3, "fetch_k": 10},
                    )
 
                    yield "data: 🔄 Vectorstore reloaded into main process.\n\n"
                    yield "data: ✅ Rebuild complete — chatbot is using fresh knowledge.\n\n"
                    break
 
                except Exception as e:
                    if attempt < max_attempts:
                        yield f"data: ⏳ Reload attempt {attempt}/{max_attempts} failed — retrying in 3s... ({e})\n\n"
                        await asyncio.sleep(3)
                    else:
                        yield f"data: ❌ Vectorstore reload failed after {max_attempts} attempts: {e}\n\n"
                        yield "data: ⚠️  Restart the server to apply the new knowledge base.\n\n"
        else:
            yield f"data: ❌ Rebuild process exited with code {exit_code}.\n\n"
 
        yield "data: __DONE__\n\n"
 
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─────────────────────────────────────────────────────────────
# ENDPOINT: /run-scraper
# ─────────────────────────────────────────────────────────────
 
@app.post("/run-scraper")
async def run_scraper():
    SCRAPER_SCRIPT = "web_scraper.py"
 
    if not os.path.exists(SCRAPER_SCRIPT):
        async def error_stream():
            yield f"data: ❌ Scraper script '{SCRAPER_SCRIPT}' not found.\n\n"
            yield "data: __DONE__\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")
 
    return await stream_subprocess(["python", "-u", SCRAPER_SCRIPT])


# ─────────────────────────────────────────────────────────────
# ENDPOINT: /run-pipeline 
# ─────────────────────────────────────────────────────────────

@app.post("/run-pipeline")
async def run_pipeline_legacy():
    return await run_rebuild()


# ─────────────────────────────────────────────────────────────
# RETRIEVER & LLM PIPELINE INITIALIZATION
# ─────────────────────────────────────────────────────────────

vs = get_vectorstore()
if vs is not None:
    retriever = vs.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 3, "fetch_k": 10},
    )
else:
    retriever = None
    print("⚠️  No vectorstore available — retriever not initialized.")


print("🤖 Initializing Llama 3.2 text LLM...")
llm = ChatOllama(model="llama3.2", temperature=0, num_ctx=4096)
print("✅ Text LLM operational.")

VISION_MODEL = "llama3.2-vision"
print(f"🔭 Initializing vision LLM ({VISION_MODEL})...")
vision_llm = ChatOllama(model=VISION_MODEL, temperature=0, num_ctx=4096)
print("✅ Vision LLM operational.")


# ─────────────────────────────────────────────────────────────
# METHOD 1: LLM-DRIVEN DYNAMIC QUERY EXPANSION ASSISTANT
# ─────────────────────────────────────────────────────────────

def expand_query_with_llm(user_query: str) -> list:
    """
    Uses the local LLM to rewrite and expand a student's question into multiple
    official academic synonyms, solving word clashing ("coordinator" vs "leader").
    """
    expansion_prompt = f"""
    You are an AI optimization assistant for a university search engine. 
    Analyze the student's question and generate 2 to 3 alternative search queries that mean 
    the exact same thing but use administrative vocabulary matching university documents (e.g., 
    coordinator, leader, psm coordinator, committee chair, supervisor, logbook submission, passing marks).
    
    STRICT COMPILATION RULES:
    1. Output ONLY a valid JSON list of strings.
    2. Do NOT include introductory text, explanations, markdown backticks, or code formatting.
    
    Student Question: "{user_query}"
    JSON Output:
    """
    try:
        print("🧠 Translating casual terms via LLM Query Expansion pass...")
        response = llm.invoke(expansion_prompt)
        content = response.content.strip() if hasattr(response, "content") else str(response).strip()
        
        # Safe string cleaning if the local layout attaches code-block backticks
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
                
        expanded_queries = json.loads(content.strip())
        if isinstance(expanded_queries, list):
            if user_query not in expanded_queries:
                expanded_queries.insert(0, user_query)
            return expanded_queries
    except Exception as e:
        print(f"⚠️ Query Expansion skipped due to formatting constraints: {e}")
        
    return [user_query]


# ─────────────────────────────────────────────────────────────
# VISION HELPER: DETERMINE IF QUESTION IS VISUALLY ORIENTED
# ─────────────────────────────────────────────────────────────

VISUAL_INTENT_KEYWORDS = {
    "show", "diagram", "image", "picture", "photo", "chart",
    "table", "form", "figure", "screenshot", "look", "display",
    "visual", "illustration", "example", "sample", "template",
}

def is_visual_question(question: str) -> bool:
    tokens = set(re.findall(r"\b\w+\b", question.lower()))
    return bool(tokens & VISUAL_INTENT_KEYWORDS)


async def describe_image_from_url(url: str) -> str:
    """Downloads an image from a URL and extracts text/markdown structure using LLaVA."""
    try:
        print(f"📸 Ingesting vision attachment asset: {url}")
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            if response.status_code != 200:
                print(f"⚠️ Image fetch failed ({response.status_code}) for {url}")
                return ""
            img_b64 = base64.b64encode(response.content).decode("utf-8")
            
        prompt = (
            "You are a precise academic document parser. Describe everything inside this image. "
            "If it contains an administrative table or calendar milestone list, transcribe all items line-by-line verbatim."
        )
        res = await asyncio.to_thread(
            ollama.generate,
            model=VISION_MODEL,
            prompt=prompt,
            images=[img_b64]
        )
        return res.get("response", "").strip()
    except Exception as vision_err:
        print(f"⚠️ Vision analysis pipeline encountered an error: {vision_err}")
        return ""


# ─────────────────────────────────────────────────────────────
# SYSTEM PROMPT
# ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """
You are a helpful PSM Universiti Teknologi Malaysia chatbot
for Faculty of Computing students.

Answer ONLY based on the provided context.
All information should come from this link only https://comp.utm.my/psm/

Rules:
1. Keep answers SHORT and clear.
2. Maximum 3 to 5 sentences.
3. Format bullet points on NEW LINES, like this:
   - Point one
   - Point two
4. NEVER put bullet points on the same line as other text.
5. If unsure, say: 'Sorry, I don't have that information.'
6. Do not repeat the question.
7. Explain in simple student-friendly language.
8. Do not copy entire paragraphs directly.
9. Add emotion if necessary.
10. Isolated Link Formatting: If a download link or documentation reference URL exists in the retrieved context, you must output it on its own completely separate single line at the very end of the response using markdown syntax (e.g., [Link Here](url)). Never introduce the link with phrases like "Here is the link" or attach it to an informative text sentence.

Always use proper line breaks between points.
"""

# ─────────────────────────────────────────────────────────────
# POST REQUEST SCHEMAS
# ─────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str

class ImageRequest(BaseModel):
    url: str

def format_docs(documents: list) -> str:
    return "\n\n".join(doc.page_content for doc in documents)


# ─────────────────────────────────────────────────────────────
# ENDPOINT: /predict  (Advanced Multi-Query RAG + Fallback)
# ─────────────────────────────────────────────────────────────

@app.post("/predict")
async def predict(request: ChatRequest):
    try:
        print("\n" + "=" * 60)
        user_message = request.message.strip()
        print(f"📩 USER ENQUIRY: {user_message}")

        vs = get_vectorstore()
        if vs is None:
            return {
                "reply": "The knowledge base is not ready yet. Please run a rebuild first.",
                "source": "error",
            }

        # ── STEP 1: DYNAMIC GENERATION OF EXPANDED QUERIES ──
        search_queries = expand_query_with_llm(user_message)
        print(f"🔍 EVALUATING PASS MULTI-QUERIES: {search_queries}")

        # ── STEP 2: MULTI-PASS VECTOR RECOVERY DEDUPLICATION LOOP ──
        retrieved_docs = []
        seen_contents = set()

        for query in search_queries:
            # Structurally align simple 1-2 word components with the template layout keys
            if len(query.split()) <= 2:
                formatted_query = f"Section Subheading Anchor: {query}"
            else:
                formatted_query = query

            docs = retriever.invoke(formatted_query)
            all_raw_docs = docs if 'docs' in locals() else []
            for doc in docs:
                if doc.page_content not in seen_contents:
                    retrieved_docs.append(doc)
                    seen_contents.add(doc.page_content)
                    
            if len(retrieved_docs) >= 4:
                break

        # ── STEP 3: HYBRID RAG LITERAL SUBSTRING PATTERN MATCH FALLBACK ──
        # Activated for brief query tokens if semantic boundaries returned empty vector spaces
        if not retrieved_docs and len(user_message.split()) <= 2:
            print("🔄 Vector distance missed. Activating keyword layout backup scanning...")
            try:
                # Dynamically reference documents tracked in the memory sequence pool
                all_raw_docs = docs if 'docs' in locals() else []
                if not all_raw_docs:
                    all_raw_docs = load_approved_knowledge_base()
                    
                fallback_matches = [
                    doc for doc in all_raw_docs
                    if user_message.lower() in doc.page_content.lower()
                ]
                retrieved_docs = fallback_matches[:3]
            except Exception as fallback_err:
                print(f"⚠️ Hybrid text parsing encountered error: {fallback_err}")

        # Strict exit guardrail if zero matching chunks are detected in the repository loop
        if not retrieved_docs:
            print("⚠️ Complete database search miss.")
            return {
                "reply": "Sorry, I don't have that information inside my verified knowledge base.",
                "source": "rag-ai",
            }

        print(f"✅ Context compilation matched {len(retrieved_docs)} verified records.")
        context = format_docs(retrieved_docs)

        # ── STEP 4: VISION CONTEXT RECOVERY PIPELINE ──
        image_context_block = ""
        check_images = is_visual_question(user_message)

        if check_images:
            print("🖼️ Visual intent detected — running image description pipeline...")
            image_descriptions = []

            for doc in retrieved_docs:
                pic_links_raw = doc.metadata.get("visual_attachments", "")
                if not pic_links_raw:
                    continue
                pic_urls = [u.strip() for u in pic_links_raw.split(",") if u.strip().startswith("http")]
                for url in pic_urls[:2]:
                    description = await describe_image_from_url(url)
                    if description:
                        image_descriptions.append(f"  • Image ({url}):\n    {description}")

            if image_descriptions:
                image_context_block = (
                    "\n\nVisual Context from Referenced Images:\n"
                    + "\n".join(image_descriptions)
                    + "\n"
                )
                print(f"✅ {len(image_descriptions)} image description(s) injected into context.")
        else:
            print("⏩ Text-only question — skipping vision pipeline for speed.")

        # ── STEP 5: STRUCTURAL FORMULATION & GENERATION ──
        final_prompt = (
            f"{SYSTEM_PROMPT}\n\n"
            f"Context:\n{context}"
            f"{image_context_block}\n"
            f"Question:\n{user_message}"
        )

        print("🐢 Invoking text model weights configuration parameter fields...")
        response = llm.invoke(final_prompt)

        if hasattr(response, "content"):
            response = response.content

        response = str(response).strip()
        response = re.sub(r'\s*•\s*', '\n- ', response)
        response = response.strip("- ").strip()

        if not response:
            response = "Sorry, I could not generate a valid response."

        print(f"🤖 AGENT RESPONSE: {response[:200]}...")
        print("=" * 60)

        return {
            "reply": response,
            "source": "rag-ai",
            "images_used": len(image_context_block) > 0,
        }

    except Exception as e:
        print(f"❌ EXCEPTION: {str(e)}")
        return {
            "reply": f"Sorry, something went wrong on the backend:\n{str(e)}",
            "source": "error",
        }


# ─────────────────────────────────────────────────────────────
# ENDPOINT: /describe-image  (Standalone image URL tester)
# ─────────────────────────────────────────────────────────────

@app.post("/describe-image")
async def describe_image_endpoint(request: ImageRequest):
    description = await describe_image_from_url(request.url)
    if description:
        return {"description": description, "status": "ok"}
    return {"description": "Could not describe the image.", "status": "failed"}


# ─────────────────────────────────────────────────────────────
# MONITORING ROUTES
# ─────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "status":       "running",
        "text_model":   "llama3.2",
        "vision_model": VISION_MODEL,
        "message":      "PSM UTM RAG AI Backend — Live-synced with Firestore + Vision Pipeline Active",
    }

@app.get("/health")
async def health():
    return {
        "status":        "healthy",
        "vector_store":  os.path.exists(DB_PATH),
        "vision_model":  VISION_MODEL,
        "timestamp":     datetime.now().isoformat(),
    }


# ─────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
