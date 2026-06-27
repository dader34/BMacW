# Third-party notices

## MS45-Flasher (GPLv3)

The DME flash read/write/erase logic in `src/EdiabasMac/FlashService.cs` is ported
from [terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher),
licensed under GPLv3. The original source is vendored at `vendor/ms45-flasher/`.

Because this project incorporates GPLv3 code, BMacW is distributed under GPLv3.
See `LICENSE`.

## EdiabasLib

The EDIABAS engine is from [uholeschak/ediabaslib](https://github.com/uholeschak/ediabaslib)
(Apache 2.0). Source is vendored at `vendor/ediabaslib-src/`.

## BMW EDIABAS / INPA data

`vendor/EDIABAS/` and `vendor/EC-APPS/` are BMW proprietary diagnostic data (SGBD
.prg files, INPA .ipo configs). They are NOT redistributed and are excluded from
this repository. Supply your own copy (BMW Standard Tools) to run the app.
