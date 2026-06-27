# OBDLink MX+ over Bluetooth on macOS, investigation result

**Conclusion: the OBDLink MX+ cannot connect over Bluetooth on macOS via any
available API.** This is a platform limitation, not a bug in BMacW. Use the
K+DCAN cable (works perfectly), or the MX+ over **USB** instead of Bluetooth.

## Why, every Bluetooth path was tested and ruled out

The MX+ (STN2255) is a **Classic Bluetooth / Apple MFi** device (confirmed by the
OBDLink Family Reference Manual §3.1 and §8.12, and by LTSupportAutomotive listing
it under "Apple MFi"). On macOS:

1. **Classic SPP serial** (`/dev/cu.OBDLinkMX*`): the serial node is created at
   pairing, and opening it succeeds, but **no bytes flow** (an `ATI` probe gets
   silence) and the baseband link drops within seconds, even from the Bluetooth
   settings panel. macOS classic-BT RFCOMM for third-party devices is effectively
   unmaintained.
2. **BLE / CoreBluetooth**: the MX+ does **not advertise as a BLE peripheral**
   (it is not a BLE device, only the newer OBDLink CX is). CoreBluetooth scans
   never find it.
3. **External Accessory (MFi)**: `EAAccessoryManager.connectedAccessories` returns
   **0**, and `IAPAppRegisterClient: registerWasSuccessful 0`, macOS will not
   register/enumerate the MFi Bluetooth accessory. (This path works on iOS, which
   is how the iOS apps connect; macOS does not support it.)

OBDLink's own support tells Mac users to run **Windows in a VM** (Parallels/
VirtualBox); their OBDWiz software is Windows-only.

## What still works / future paths

- **K+DCAN cable** over `/dev/tty.usbserial*`, the primary, fully-working E46
  interface (codes, live data, activations all verified on the car).
- **MX+ over USB**, plug the adapter into the Mac's USB port; it enumerates as a
  normal serial device and would work with the ELM engine (no Bluetooth involved).
- The **ELM/STN engine support** (EdElmSerialInterface / EdElmWifiInterface) stays
  compiled in, usable the moment there's a stable transport: MX+ over USB, an MX+
  Wi-Fi model, or a CAN-bus BMW.
