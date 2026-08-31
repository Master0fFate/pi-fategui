# Themes

Fate UI ships with built-in themes across dark and light tones — and maps any Pi-compatible theme into the same palette. Pick one under **Settings → Interface → Theme**.

## Create your own theme

A custom theme is just a small JSON file that Fate UI validates and loads next to the built-ins.

1. Put a `themes.json` in your Fate UI data folder. Fate UI drops a filled-in `themes.example.json` there on first launch, so you can copy that to get going.

   - **Windows:** `%USERPROFILE%\.pi\fateGUI\themes.json`
   - **macOS / Linux:** `~/.pi/fateGUI/themes.json`

2. Define one or more themes. Each one needs a lowercase `id`, a display `name`, a `tone`, and all 20 color tokens as six-digit hex:

   ```json
   {
     "themes": [
       {
         "id": "storm",
         "name": "Storm",
         "tone": "dark",
         "colors": {
           "canvas": "#101218", "panel": "#151821", "raised": "#1c202b",
           "raisedHover": "#252b38", "border": "#303746", "borderStrong": "#444d60",
           "text": "#f0f2f7", "textSoft": "#c5cad5", "muted": "#8d96a8",
           "subtle": "#657084", "accent": "#6f8cff", "accentHover": "#8ca2ff",
           "accentSoft": "#222b49", "currentSession": "#2b3050",
           "lastActiveSession": "#1c202b", "onAccent": "#ffffff", "success": "#55c78a",
           "warning": "#d2a94b", "danger": "#e35d6a", "shadow": "#020308"
         }
       }
     ]
   }
   ```

3. Reopen Settings (or restart Fate UI). Your theme shows up in the dropdown, tagged dark or light.

The `id` is lowercase letters, digits, and hyphens (`[a-z0-9][a-z0-9-]`, 2–48 characters), `tone` is `dark` or `light`, and every one of the 20 tokens is required — together they cover the whole surface Fate UI paints, from canvas and panels down to syntax and tool-output color. `currentSession` marks the session receiving prompts; `lastActiveSession` marks a session that was last active in another project. Keep them visibly different. Up to 24 custom themes load from a single file.

Themes made before these two tokens existed still load. Fate UI uses `accentSoft` for `currentSession` and `raised` for `lastActiveSession` until you add explicit values.

Themes Pi already knows about are picked up automatically too, including any a project keeps under its own `.pi` resources once you trust it, so the palette you run in the terminal Pi carries over.
