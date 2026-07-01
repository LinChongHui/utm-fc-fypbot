# rebuild_db.py
import sys
sys.stdout.reconfigure(encoding='utf-8')

import os
import json
import hashlib
import shutil
import time
import gc
from datetime import datetime

import firebase_admin
from firebase_admin import credentials, firestore

from langchain_community.vectorstores import Chroma
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings
from langchain_core.documents import Document

# ── Config ────────────────────────────────────────────────────
DB_PATH      = "./chroma_db_local"
DB_PATH_NEW  = "./chroma_db_new"       # ← build here first
DB_PATH_OLD  = "./chroma_db_old"       # ← old DB parked here during swap
HASH_FILE    = "./chroma_db_local/.kb_fingerprint"

# ── Firestore ─────────────────────────────────────────────────
def init_firestore_client():
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()

def load_approved_knowledge_base():
    db = init_firestore_client()
    print("🛰️  Connecting to Firestore 'psm_sections' collection...")
    docs_ref = db.collection("psm_sections").where(
        filter=firestore.FieldFilter("approved", "==", True)
    )
    docs = docs_ref.stream()

    langchain_documents = []
    count = 0

    snapshot_filename = "ai_knowledge_base_snapshot.txt"
    with open(snapshot_filename, "w", encoding="utf-8") as snapshot_file:
        snapshot_file.write(f"Snapshot generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")

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

            snapshot_file.write(f"--- [CHUNK #{count}] ---\n{formatted_page_content}\n\n")

            langchain_documents.append(Document(
                page_content=formatted_page_content,
                metadata={
                    "id": doc.id, "category": "verified_kb_node",
                    "source": page_url, "path": path_str,
                    "title": page_title, "heading": heading,
                    "downloadable_documents": doc_links_str,
                    "visual_attachments": picture_links_str,
                    "ingested_at": datetime.now().isoformat(),
                }
            ))

    print(f"✅ Retrieved {count} approved sections from Firestore!")
    return langchain_documents

# ── Fingerprint ───────────────────────────────────────────────
def compute_kb_fingerprint():
    db   = init_firestore_client()
    docs = db.collection("psm_sections").where(
        filter=firestore.FieldFilter("approved", "==", True)
    ).stream()
    entries = []
    for doc in docs:
        data = doc.to_dict()
        ts   = str(data.get("updatedAt", "")) or str(data.get("scraped_at", ""))
        entries.append(f"{doc.id}:{ts}")
    entries.sort()
    fp = hashlib.sha256(json.dumps(entries).encode()).hexdigest()
    print(f"🔑 Fingerprint: {fp[:16]}... ({len(entries)} approved docs)")
    return fp, len(entries)

def load_saved_fingerprint():
    try:
        if os.path.exists(HASH_FILE):
            with open(HASH_FILE) as f:
                return f.read().strip()
    except Exception:
        pass
    return ""

def save_fingerprint(fp):
    os.makedirs(DB_PATH, exist_ok=True)
    hash_file = os.path.join(DB_PATH, ".kb_fingerprint")
    with open(hash_file, "w") as f:
        f.write(fp)
    print(f"💾 Fingerprint saved: {fp[:16]}...")

def force_release_chroma(vectorstore):
    """
    Forcefully stop ChromaDB's internal system and release all Windows file locks.
    Must be called BEFORE any shutil.move/rmtree on the DB folder.
    """
    if vectorstore is None:
        return
    try:
        vectorstore._client._system.stop()
        print("🔓 Chroma internal system stopped.")
    except Exception as e:
        print(f"⚠️  Could not stop Chroma system: {e}")
    try:
        from chromadb.api.client import SharedSystemClient
        SharedSystemClient.clear_system_cache()
        print("🧹 Chroma system cache cleared.")
    except Exception as e:
        print(f"⚠️  Could not clear Chroma cache: {e}")

def safe_remove(path, retries=8, delay=2):
    """Delete a folder, retrying on Windows PermissionError."""
    for attempt in range(1, retries + 1):
        try:
            shutil.rmtree(path)
            print(f"🗑️  Removed: {path}")
            return
        except PermissionError as e:
            if attempt < retries:
                print(f"⚠️  Locked — retrying in {delay}s (attempt {attempt}/{retries})...")
                gc.collect()
                time.sleep(delay)
            else:
                raise RuntimeError(f"❌ Cannot delete '{path}' after {retries} attempts: {e}")

def safe_move(src, dst, retries=8, delay=2):
    """Move a folder, retrying on Windows PermissionError."""
    for attempt in range(1, retries + 1):
        try:
            shutil.move(src, dst)
            print(f"🔀 Moved: {src} → {dst}")
            return
        except PermissionError as e:
            if attempt < retries:
                print(f"⚠️  Move locked — retrying in {delay}s (attempt {attempt}/{retries})...")
                gc.collect()
                time.sleep(delay)
            else:
                raise RuntimeError(f"❌ Cannot move '{src}' → '{dst}' after {retries} attempts: {e}")

# ── Main rebuild logic ────────────────────────────────────────
def main():
    print("📦 Preparing structured knowledge blocks for vectorizing...")
    raw_docs = load_approved_knowledge_base()

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=800, chunk_overlap=80, length_function=len
    )
    docs = splitter.split_documents(raw_docs)
    print(f"✅ Total chunk segments after text split: {len(docs)}")

    print("🧠 Loading embedding model (nomic-embed-text)...")
    embeddings = OllamaEmbeddings(model="nomic-embed-text")

    current_fp, doc_count = compute_kb_fingerprint()
    saved_fp = load_saved_fingerprint()

    if doc_count == 0:
        print("⚠️  WARNING: Firestore returned 0 approved documents.")
        print("   Check that 'psm_sections' documents have approved == true (boolean).")
        return

    if current_fp and current_fp == saved_fp and os.path.exists(DB_PATH):
        print("✅ No changes detected — Chroma DB is already up to date.")
        return

    print("🔄 Change detected — rebuilding into temp folder first...")

    # ── Clean up any leftover temp folders from a previous failed run ──
    if os.path.exists(DB_PATH_NEW):
        safe_remove(DB_PATH_NEW)
    if os.path.exists(DB_PATH_OLD):
        safe_remove(DB_PATH_OLD)

    if not docs:
        print("⚠️  No approved docs to embed — skipping.")
        return

    # ── Step 1: Build into DB_PATH_NEW ───────────────────────
    # main.py continues serving from DB_PATH uninterrupted during this step
    print(f"📂 Building new DB at: {DB_PATH_NEW}")
    vectorstore = None
    BATCH_SIZE = 50
    for i in range(0, len(docs), BATCH_SIZE):
        batch = docs[i:i + BATCH_SIZE]
        if vectorstore is None:
            vectorstore = Chroma.from_documents(
                documents=batch,
                embedding=embeddings,
                persist_directory=DB_PATH_NEW,
                collection_name="psm_utm_kb",
            )
        else:
            vectorstore.add_documents(batch)
        print(f"✅ Embedded batch {i // BATCH_SIZE + 1} "
              f"({min(i + BATCH_SIZE, len(docs))}/{len(docs)} segments)")

    # ── Step 2: Force-release all Windows file locks on DB_PATH_NEW ──
    # del + gc alone is NOT enough on Windows — must stop internal system
    print("🔓 Releasing Chroma file locks before swap...")
    force_release_chroma(vectorstore)
    vectorstore = None
    gc.collect()

    # Give Windows time to release kernel file handles after system.stop()
    print("⏳ Waiting for OS to release file handles...")
    time.sleep(5)
    print("✅ File handles released.")

    # ── Step 3: Atomic swap ───────────────────────────────────
    # Park old DB → chroma_db_old  (fast rename, main.py unaffected)
    if os.path.exists(DB_PATH):
        print(f"📦 Parking old DB → {DB_PATH_OLD}")
        safe_move(DB_PATH, DB_PATH_OLD)

    # Promote new DB → chroma_db_local  (main.py will reload from here)
    print(f"🔀 Promoting new DB → {DB_PATH}")
    safe_move(DB_PATH_NEW, DB_PATH)

    # ── Step 4: Save fingerprint inside the new live DB ──────
    save_fingerprint(current_fp)

    # ── Step 5: Remove old DB ─────────────────────────────────
    if os.path.exists(DB_PATH_OLD):
        print(f"🗑️  Cleaning up old DB...")
        safe_remove(DB_PATH_OLD)

    print("✅ Vector database rebuilt and fingerprint updated.")
    print("✅ DB swap complete. Safe to reload.")

if __name__ == "__main__":
    main()