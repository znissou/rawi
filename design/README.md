# Icon sources

The current icon is **concept 2, "The prompt speaks"**: a terminal chevron sending out sound waves, aqua to violet on a dark tile. The user chose it on 2026-11-09.

- `../media/icon.png`: the extension icon, 256 px.
- `rawi.ico`: 16 to 256 px, for the Windows folder icon.
- `icon-1024.png`: the rounded master both are made from.
- `concepts/`: the four raw images. Each also has an `.ico`, so any of them can be tried on the folder.
- `prompts/`: the prompt used for each concept.

## How they were made
1. OpenRouter Images API (`POST /api/v1/images`), model `openai/gpt-image-2.6-sunburst`, 1024×1024, `quality: high`. It cost $0.054 per image.
2. A first round (a speech bubble with the Arabic letter ر, indigo and gold) was rejected.
3. `make_icons.py` (Python 3 + Pillow) finds the symbol, crops so it fills 78% of the tile, and rounds the corners (22% radius). It writes the master, PNG frames and a 10-size `.ico`:
   ```
   python make_icons.py concepts/2-prompt-speaks.png out 2-prompt-speaks 0.78
   ```

## Switching to another concept
Run the script on the other concept, then copy:
- `out/<name>-1024.png` to `icon-1024.png`
- `out/frames/<name>-256.png` to `../media/icon.png`
- `out/<name>.ico` to `rawi.ico`

## Folder icon
Right-click the project folder, then Properties → Customize → Change Icon… → Browse → `design\rawi.ico`. Windows adds a hidden `desktop.ini` to the folder, which `.gitignore` must exclude.

## Still to do (M1)
A one-colour SVG of the symbol for the activity bar and the status bar.
