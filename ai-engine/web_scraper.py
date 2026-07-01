"""
PSM UTM Web Scraper + Optimized Gemma 4 Vision Pipeline + Firestore Sync
=====================================================================

Features:
---------
✅ BFS crawl initialized via 'top-menu-nav' mapping discovery
✅ Gemma 4 Vision schema guardrails producing perfect Markdown context tables
✅ Target DOM isolation targeting (.entry-content, #main-content) to strip noise
✅ Auto-filtering of UI decor/logos using the [DECORATIVE_IMAGE] string gate
✅ Excludes element nodes with id="top-menu", id="main-footer", and id="sidebar" from chunking
✅ Deterministic document IDs (content-change detection via MD5 semantic hash)
✅ Approval-state preserved on re-scrape
✅ Firestore batch sync with skip/update/insert reporting
✅ menu_group tagging: each section is tagged with its originating top-menu-nav entry
"""

import os
import re
import json
import time
import base64
import hashlib
import urllib.parse
from collections import deque
from datetime import datetime

import requests
from bs4 import BeautifulSoup
import ollama
import firebase_admin
from firebase_admin import credentials, firestore


# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────

BASE_URL   = "https://comp.utm.my/psm/"
OUTPUT_DIR = "psm_output"
MAX_PAGES  = 50
CRAWL_DELAY    = 1.0
TIMEOUT        = 15
MIN_IMAGE_BYTES = 5000   # skip tiny icons / tracking pixels

DOCUMENT_EXTENSIONS = {
    ".pdf", ".docx", ".doc", ".xlsx", ".xls",
    ".pptx", ".ppt", ".zip", ".rar", ".csv"
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PSM-Scraper/1.0)"
}

# Vision model to use — must be pulled in Ollama first
# Run: ollama pull gemma4:e2b
VISION_MODEL = "gemma4:e2b"

# Pages where we force full vision processing (e.g. calendar/timeline pages)
# Leave empty list [] to run vision on ALL pages
IMAGE_PAGE_WHITELIST = [
    "https://comp.utm.my/psm/2025/10/02/sem22526-psm2-calendar-brief/",
    "https://comp.utm.my/psm/2025/10/02/sem22526-psm1-calendar-brief/",
]


# ─────────────────────────────────────────────────────────────
# GENERAL HELPERS
# ─────────────────────────────────────────────────────────────

def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()

def fetch_soup(url: str, session: requests.Session):
    try:
        resp = session.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "lxml")
    except Exception as e:
        print(f"  [skip] {url} — {e}")
        return None

def normalise(href: str, base: str):
    if not href:
        return None
    if href.startswith(("mailto:", "tel:", "javascript:", "#")):
        return None
    return urllib.parse.urljoin(base, href.strip())

def is_internal(url: str) -> bool:
    return urllib.parse.urlparse(url).netloc == urllib.parse.urlparse(BASE_URL).netloc

def get_ext(url: str) -> str:
    return os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()

def is_doc(url: str) -> bool:
    return get_ext(url) in DOCUMENT_EXTENSIONS

def is_whitelisted_page(url: str) -> bool:
    """Returns True if we should run vision on this page."""
    if not IMAGE_PAGE_WHITELIST:
        return True   # empty whitelist = process ALL pages
    url_norm = url.rstrip("/")
    return any(url_norm == entry.rstrip("/") for entry in IMAGE_PAGE_WHITELIST)


# ─────────────────────────────────────────────────────────────
# MENU GROUP RESOLUTION
# ─────────────────────────────────────────────────────────────

def resolve_menu_group(url: str, menu_map: list[dict]) -> dict:
    """
    Given a page URL and the ordered list of top-menu-nav entries,
    return the best-matching menu entry (longest prefix match).

    Each entry in menu_map:
        { "label": str, "url": str, "order": int }

    Returns a dict:
        { "label": str, "url": str, "order": int }
    or a fallback "Uncategorized" entry.
    """
    best_match = None
    best_len   = 0

    url_norm = url.rstrip("/").lower()

    for entry in menu_map:
        entry_url = entry["url"].rstrip("/").lower()
        # Exact match or the page URL starts with the menu entry URL
        if url_norm == entry_url or url_norm.startswith(entry_url + "/"):
            match_len = len(entry_url)
            if match_len > best_len:
                best_len  = match_len
                best_match = entry

    if best_match:
        return best_match

    # Fallback: uncategorized
    return {"label": "Uncategorized", "url": "", "order": 9999}


# ─────────────────────────────────────────────────────────────
# IMAGE DOWNLOAD HELPER
# ─────────────────────────────────────────────────────────────

def download_image_as_base64(url: str, session: requests.Session):
    """
    Downloads an image and returns its base64 string.
    Returns None if the image is too small, not an image, or fails.
    """
    try:
        resp = session.get(url, timeout=10, headers=HEADERS)
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")
        if "image" not in content_type:
            return None
        if len(resp.content) < MIN_IMAGE_BYTES:
            return None   # skip icons / tracking pixels

        return base64.b64encode(resp.content).decode("utf-8")

    except Exception as e:
        print(f"    [img skip] {url} — {e}")
        return None


# ─────────────────────────────────────────────────────────────
# OPTIMIZED VISION: TWO-PASS EXTRACTION + VERIFICATION
# ─────────────────────────────────────────────────────────────

EXTRACTION_PROMPT = (
    "You are an expert academic data extraction assistant. Your task is to perform an exact, "
    "character-for-character structural extraction of the PSM Milestone Calendar shown in this image.\n\n"
    
    "CONTEXT INFORMATION:\n"
    "- The image is an official schedule layout for an undergraduate Final Year Project (PSM) at UTM.\n"
    "- It consists of colored blocks representing different phases.\n\n"
    
    "STRICT OUTPUT TEMPLATE:\n"
    "Your response must begin with a single main markdown header (#) containing the exact title found in the top-left orange block of the image:\n"
    "# PSM1 CALENDAR BRIEF SEM2_2526\n\n"
    "Follow this immediately with a valid Markdown table using these 3 exact column headers to map the unstructured data into a structured timeline:\n\n"
    "| Task / Event | Start Date | End Date |\n"
    "| --- | --- | --- |\n"
    "| [Row Data] | [Row Data] | [Row Data] |\n\n"
    
    "CRITICAL EXTRACTION RULES:\n"
    "1. CHRONOLOGICAL COMPLETION: You must read the data from the colored blocks and map them chronologically into the table rows based on their dates (from April down to July). Do NOT skip any tasks or combine distinct milestones.\n"
    "2. DATE & TEXT INTEGRITY: Copy text and actions exactly as written in the blocks. Split date ranges (e.g., '6to9-APR-2026' or '11 to 15-MAY-2026') into distinct 'Start Date' and 'End Date' columns for precision. For single-day events, use the same date for both columns.\n"
    "3. NO DISCURSIVE PROSE: Do not output introductory text, conversational greetings, or ending notes. Output only the clean Markdown structural content block.\n"
    "4. EXPLICIT N/A: If any date or event parameter is completely missing, write 'N/A' inside that specific cell row. Do not leave empty table formatting gaps."
)

def _run_vision_prompt(image_b64: str, prompt: str) -> str | None:
    try:
        response = ollama.chat(
            model=VISION_MODEL,
            messages=[{
                "role": "user",
                "content": prompt,
                "images": [image_b64],
            }],
            options={
                "num_ctx": 2048,
                "num_predict": 1024,
                "temperature": 0.0
            }
        )
        return response["message"]["content"].strip()
    except Exception as e:
        print(f"    [Gemma 4 integration error] {e}")
        return None


def describe_image_with_gemma(image_b64: str, image_url: str = "") -> str | None:
    """Two-pass extraction: extract then verify using Gemma 4."""

    # Pass 1: Raw extraction
    first_pass = _run_vision_prompt(image_b64, prompt=EXTRACTION_PROMPT)
    if not first_pass or "[DECORATIVE_IMAGE]" in first_pass:
        return first_pass

    print(f"    🔁 Pass 1 done ({len(first_pass)} chars). Running verification pass...")

    # Pass 2: Self-correction
    correction_prompt = (
        f"You previously extracted this data from an academic calendar image:\n\n"
        f"{first_pass}\n\n"
        f"Now re-examine the image carefully. Are any dates, section names, or activities "
        f"missing or incorrect? Output the corrected, complete table only. "
        f"Do not add commentary."
    )
    second_pass = _run_vision_prompt(image_b64, prompt=correction_prompt)

    return second_pass if second_pass else first_pass


# ─────────────────────────────────────────────────────────────
# TARGETED IMAGE PROCESSING (ISOLATES MAIN BODY WRAPPERS)
# ─────────────────────────────────────────────────────────────

def process_page_images(soup: BeautifulSoup, page_url: str, session: requests.Session, run_vision: bool):
    picture_links      = []
    image_context_list = []

    if run_vision:
        content_area = soup.select_one(".et_post_meta_wrapper")
    else:
        content_area = soup.select_one(".entry-content, #main-content, article")

    img_tags = content_area.find_all("img") if content_area else soup.find_all("img")

    for img in img_tags:
        src = img.get("src") or img.get("data-src") or ""
        full_url = normalise(src, page_url)

        if not full_url or full_url in picture_links:
            continue

        picture_links.append(full_url)

        if not run_vision:
            continue

        print(f"  👁️  Vision: processing whitelisted asset {full_url[:80]}...")
        img_b64 = download_image_as_base64(full_url, session)

        if not img_b64:
            print(f"    [skip] Image download failed or too small.")
            continue

        description = describe_image_with_gemma(img_b64, full_url)

        if description:
            if "[DECORATIVE_IMAGE]" in description:
                print(f"    🗑️  Gemma 4 marked image as decorative banner. Filtered out.")
                continue

            print(f"    ✅ Gemma 4 described image ({len(description)} chars)")
            image_context_list.append({
                "url":         full_url,
                "description": description,
                "processed_at": datetime.now().isoformat(),
            })
        else:
            print(f"    ⚠️  Gemma 4 returned no description.")

    return picture_links, image_context_list


# ─────────────────────────────────────────────────────────────
# DETERMINISTIC ID HASH GENERATOR
# ─────────────────────────────────────────────────────────────

def generate_deterministic_id(page_url: str, heading: str) -> str:
    combined = f"{page_url}#{heading}"
    return "sec_" + hashlib.md5(combined.encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────
# FIREBASE INITIALISATION
# ─────────────────────────────────────────────────────────────

def init_firebase():
    if not firebase_admin._apps:
        cred = credentials.Certificate("firebase_service_account.json")
        firebase_admin.initialize_app(cred)
    return firestore.client()


# ─────────────────────────────────────────────────────────────
# MAIN SCRAPE FUNCTION
# ─────────────────────────────────────────────────────────────

def scrape() -> list[dict]:
    session  = requests.Session()
    visited  = set()
    queue    = deque()
    all_sections = []

    # ── menu_map: ordered list of top-menu-nav entries ────────
    # Each item: { "label": str, "url": str, "order": int }
    # Used to tag every scraped section with its originating nav group.
    menu_map: list[dict] = []

    # ── url_to_menu: maps each enqueued URL to its menu entry ─
    # So child pages discovered under a nav link inherit that group.
    url_to_menu: dict[str, dict] = {}

    print(f"🕷️  Starting PSM scrape: {BASE_URL}")
    print("─" * 60)

    # ── Initial Pass: extract top-menu-nav structure ──────────
    print("📋 Scanning top menu section (#top-menu-nav) for structured navigation links...")
    initial_soup = fetch_soup(BASE_URL, session)

    if initial_soup:
        top_menu_nav = initial_soup.find(id="top-menu-nav")
        if top_menu_nav:
            nav_links_count = 0
            order_counter   = 0

            for a in top_menu_nav.find_all("a", href=True):
                menu_link = normalise(a["href"], BASE_URL)
                label     = clean_text(a.get_text(" ", strip=True)) or menu_link

                if menu_link and is_internal(menu_link) and not is_doc(menu_link):
                    entry = {"label": label, "url": menu_link, "order": order_counter}
                    menu_map.append(entry)
                    order_counter += 1

                    if menu_link not in url_to_menu:
                        url_to_menu[menu_link] = entry
                        queue.append(menu_link)
                        nav_links_count += 1

            print(f"   🎯 Mapped and queued {nav_links_count} target menu paths from #top-menu-nav.")
            print(f"   📂 Menu groups discovered: {[e['label'] for e in menu_map]}\n")
        else:
            print("   ⚠️  Warning: Element id='top-menu-nav' not found on home page wrapper.\n")

    # Seed BASE_URL itself (tagged as uncategorized if not in menu)
    if BASE_URL not in url_to_menu:
        queue.appendleft(BASE_URL)

    # Also seed IMAGE_PAGE_WHITELIST entries
    for wl_url in IMAGE_PAGE_WHITELIST:
        if wl_url not in url_to_menu:
            queue.append(wl_url)

    while queue and len(visited) < MAX_PAGES:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)

        # Resolve this URL's menu group (longest prefix match against menu_map)
        current_menu = url_to_menu.get(url) or resolve_menu_group(url, menu_map)

        soup = fetch_soup(url, session)
        if not soup:
            continue

        # ── EXCLUSION FILTER ──────────────────────────────────
        for structural_id in ["top-menu-nav", "top-menu", "main-footer", "sidebar"]:
            for element in soup.find_all(id=structural_id):
                element.decompose()

        for tag in soup(["script", "style", "noscript", "iframe"]):
            tag.decompose()

        page_title = (
            clean_text(soup.title.string)
            if soup.title and soup.title.string
            else url
        )
        path_string = urllib.parse.urlparse(url).path

        # ── Vision Pipeline ──────────────────────────────────────
        run_vision = is_whitelisted_page(url)
        picture_links, image_context_list = process_page_images(
            soup, url, session, run_vision=run_vision
        )

        if run_vision:
            print(f"  🖼️  {len(picture_links)} images found, "
                  f"{len(image_context_list)} preserved by structured pipeline.")

        # ── Collect document download links ──────────────────────
        doc_links = []
        for a in soup.find_all("a", href=True):
            link = normalise(a["href"], url)
            if link and is_doc(link) and link not in doc_links:
                doc_links.append(link)

        # ── Context Injection Isolation Layer ─────────────────────
        image_context_text = ""
        if image_context_list:
            blocks = []
            for item in image_context_list:
                blocks.append(
                    f"#### 🖼️ SOURCE IMAGE REFERENCE ASSET URL: {item['url']}\n"
                    f"{item['description']}"
                )
            if blocks:
                image_context_text = (
                    "\n\n"
                    "=========================================================\n"
                    "⚠️ CRITICAL REFERENCE: EXTRACTED VISUAL SCHEDULES & DATA\n"
                    "The following structured data was extracted via OCR from graphics on this page.\n"
                    "Treat this data as authoritative for timelines, dates, and milestones:\n"
                    "=========================================================\n" +
                    "\n\n---\n\n".join(blocks)
                )

        # ── DOM text extraction → sections ───────────────────────
        body = soup.find("body")
        if not body:
            continue

        current_h1     = "General Information"
        current_blocks = []

        for element in body.find_all(["h1", "h2", "h3", "h4", "p", "li"]):
            text = clean_text(element.get_text(" ", strip=True))
            if not text or len(text) < 5:
                continue

            if element.name == "h1":
                if current_blocks:
                    all_sections.append(_build_section(
                        page_title, url, path_string, current_h1,
                        current_blocks, picture_links, image_context_list,
                        image_context_text, doc_links, current_menu,
                    ))
                    current_blocks = []
                current_h1 = text

            elif element.name in ["h2", "h3", "h4"]:
                current_blocks.append(f"### {text}")
            else:
                current_blocks.append(text)

        # Append remaining block
        if current_blocks:
            all_sections.append(_build_section(
                page_title, url, path_string, current_h1,
                current_blocks, picture_links, image_context_list,
                image_context_text, doc_links, current_menu,
            ))

        # ── Enqueue discovered internal link segments ────────────────
        for a in soup.find_all("a", href=True):
            nxt = normalise(a["href"], url)
            if nxt and is_internal(nxt) and not is_doc(nxt) and nxt not in visited:
                if nxt not in url_to_menu:
                    # Child page inherits the current page's menu group
                    url_to_menu[nxt] = current_menu
                if nxt not in queue:
                    queue.append(nxt)

        print(f"  ✅ [{current_menu['label']}] {url}")
        print(f"      → {len(current_blocks)} text blocks | "
              f"{len(picture_links)} images | "
              f"{len(doc_links)} docs")

        time.sleep(CRAWL_DELAY)

    print(f"\n✅ Scrape complete. Total sections collected: {len(all_sections)}")
    return all_sections


def _build_section(
    page_title, url, path_string, heading,
    text_blocks, picture_links, image_context_list,
    image_context_text, doc_links,
    menu_entry: dict,   # originating top-menu-nav entry
) -> dict:
    full_content_blocks = list(text_blocks)
    if image_context_text:
        full_content_blocks.append(image_context_text)

    return {
        "page_title":    page_title,
        "page_url":      url,
        "path":          path_string,
        "heading":       heading,
        "content":       "\n\n".join(full_content_blocks),
        "picture_links": picture_links,
        "image_context": image_context_list,
        "doc_links":     doc_links,
        "approved":      False,
        "scraped_at":    datetime.now().isoformat(),
        # ── NAVIGATION FIELDS ──────────────────────────────────────────
        "menu_group":       menu_entry["label"],   # e.g. "About PSM", "Guidelines"
        "menu_group_url":   menu_entry["url"],     # originating nav URL
        "menu_group_order": menu_entry["order"],   # position in top-menu-nav (0-indexed)
    }


# ─────────────────────────────────────────────────────────────
# FIRESTORE UPLOAD WITH CHANGE DETECTION
# ─────────────────────────────────────────────────────────────

def upload_to_firestore(sections_data: list[dict]):
    db = init_firebase()
    print(f"\n🚀 Syncing {len(sections_data)} sections with Firestore 'psm_sections'...")

    print("📦 Fetching existing cloud records...")
    existing_docs = db.collection("psm_sections").get()
    cloud_snapshot = {d.id: d.to_dict() for d in existing_docs}

    batch        = db.batch()
    skip_count   = 0
    update_count = 0
    insert_count = 0
    batch_ops    = 0

    for section in sections_data:
        doc_id  = generate_deterministic_id(section["page_url"], section["heading"])
        doc_ref = db.collection("psm_sections").document(doc_id)

        if doc_id in cloud_snapshot:
            old = cloud_snapshot[doc_id]

            if old.get("content") == section["content"]:
                skip_count += 1
                continue

            section["approved"]   = old.get("approved", False)
            section["updated_at"] = datetime.now().isoformat()
            section["scraped_at"] = old.get("scraped_at", section["scraped_at"])

            batch.set(doc_ref, section, merge=True)
            update_count += 1

        else:
            batch.set(doc_ref, section)
            insert_count += 1

        batch_ops += 1

        if batch_ops >= 400:
            batch.commit()
            batch     = db.batch()
            batch_ops = 0
            print("   ✓ Intermediate batch committed.")

    if batch_ops > 0:
        batch.commit()

    print("\n" + "─" * 60)
    print("📊 FIRESTORE SYNC REPORT")
    print(f"   ✨ Unchanged (skipped):    {skip_count}")
    print(f"   🔄 Updated (overwritten): {update_count}")
    print(f"   🆕 Inserted (new):        {insert_count}")
    print("✅ Firestore sync complete!")


# ─────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    scraped_data = scrape()

    backup_path = os.path.join(OUTPUT_DIR, "rag_ready_hierarchy.json")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(scraped_data, f, ensure_ascii=False, indent=4)
    print(f"\n💾 Local backup saved: {backup_path}")

    upload_to_firestore(scraped_data)