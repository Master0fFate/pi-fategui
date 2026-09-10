# Ashen Terminal — importable test pack

In Fate UI, open Settings → Skins → Import skin folder and choose this folder.
Preview Ashen Terminal, then Save changes. Its optional Ashen Terminal palette
appears separately in the color picker; the pack never forces a color change.

The importer installs a normalized copy in ~/.pi/fateGUI/skins/ashen-terminal/
(or beneath FATE_GUI_DATA_DIR). The source folder is not modified.

background.png is a deterministic synthetic grayscale folded-light test image,
not a photograph or an external artist's work. Fate UI converts it into a small
binary-alpha dither on import. Exported packs contain the processed PNG rather
than the original image. No external source assets or fonts are required.

To create another pack, change the ID and name, keep schemaVersion 1, choose
Default (`default`) or Angelcore (`dreamcore`) as the base, and use only the documented manifest options.
No CSS, HTML, JavaScript, nested folders, or symlinks belong in a version 1 pack.
