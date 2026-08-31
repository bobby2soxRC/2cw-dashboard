"""
sync_menu_images.py
====================
Pulls current menu imagery from the "2CW Menu Images" Google Drive folder
into img/menu/, so marketing/design can manage the menu's logo, banners,
and product photos in Drive without touching the repo. Triggered manually
via the "Sync Menu Images" GitHub Action (Actions tab -> Run workflow)
whenever new art has been uploaded to that folder.

Google Drive won't serve images directly to a third-party page (it blocks
hotlinked <img> embeds even from a publicly-shared folder), so this script
is the bridge: it copies whatever's currently in Drive into the repo, and
the site serves those local copies as it always has.

Requires DRIVE_API_KEY env var -- a Google Cloud API key with the Drive API
enabled. No OAuth/service account needed since the folder is shared as
"Anyone with the link", which an API key can read anonymously.

Every image slot starts life in Drive as a 1x1 transparent placeholder PNG
(68 bytes) until real art replaces it. Anything at or under
PLACEHOLDER_MAX_BYTES is skipped, so an un-swapped slot never overwrites a
good local file with a blank one.
"""
import os
import sys

import requests

FOLDER_ID = "1t8zwDVyoyCbmdmIRs3dUJHO6qO_qgLJv"
DEST_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "img", "menu")
PLACEHOLDER_MAX_BYTES = 200  # real photos are always far bigger than the 68-byte placeholder


def list_folder_files(api_key):
    files = []
    page_token = None
    while True:
        params = {
            "q": f"'{FOLDER_ID}' in parents and trashed = false",
            "key": api_key,
            "fields": "nextPageToken, files(id,name,size,mimeType)",
            "pageSize": 100,
        }
        if page_token:
            params["pageToken"] = page_token
        res = requests.get("https://www.googleapis.com/drive/v3/files", params=params, timeout=30)
        res.raise_for_status()
        data = res.json()
        files.extend(data.get("files", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return files


def download_file(file_id, api_key):
    res = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        params={"alt": "media", "key": api_key},
        timeout=60,
    )
    res.raise_for_status()
    return res.content


def main():
    api_key = os.environ.get("DRIVE_API_KEY")
    if not api_key:
        print("DRIVE_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    os.makedirs(DEST_DIR, exist_ok=True)
    files = list_folder_files(api_key)
    if not files:
        print("No files found in the Drive folder -- check sharing is still 'Anyone with the link'.")
        return

    # Only sync plain image files -- the spec spreadsheet also lives in this
    # folder and isn't something we want written into img/menu/.
    image_files = [f for f in files if f.get("mimeType", "").startswith("image/")]

    updated, skipped_placeholder = [], []
    for f in image_files:
        name = f["name"]
        size = int(f.get("size") or 0)
        if size <= PLACEHOLDER_MAX_BYTES:
            skipped_placeholder.append(name)
            continue

        content = download_file(f["id"], api_key)
        dest_path = os.path.join(DEST_DIR, name)

        existing = None
        if os.path.exists(dest_path):
            with open(dest_path, "rb") as fh:
                existing = fh.read()
        if existing == content:
            continue

        with open(dest_path, "wb") as fh:
            fh.write(content)
        updated.append(name)

    print(f"Updated {len(updated)} file(s): {', '.join(updated) or '(none)'}")
    print(f"Still placeholder, skipped {len(skipped_placeholder)}: {', '.join(skipped_placeholder) or '(none)'}")


if __name__ == "__main__":
    main()
