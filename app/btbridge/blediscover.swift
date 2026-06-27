// blediscover, find the OBDLink MX+ over BLE and dump its GATT services and
// characteristics, so we know the UART TX/RX UUIDs to bridge.
//
// Build: swiftc -O -framework CoreBluetooth -framework Foundation blediscover.swift -o blediscover
// Run:   ./blediscover            (scans + connects to first OBD/MX device, prints UUIDs)
//
// NOTE: macOS may require Bluetooth permission for the terminal/app running this.
// If it prints "unauthorized", grant Bluetooth access in System Settings > Privacy.

import Foundation
import CoreBluetooth

func log(_ s: String) { print(s); fflush(stdout) }

final class Discover: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var cm: CBCentralManager!
    var target: CBPeripheral?

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn: log("BLE on, scanning for OBDLink/MX…"); c.scanForPeripherals(withServices: nil)
        case .unauthorized: log("BLE UNAUTHORIZED, grant Bluetooth permission to this app/terminal in System Settings > Privacy & Security > Bluetooth")
        case .poweredOff: log("BLE powered off")
        default: log("BLE state: \(c.state.rawValue)")
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData d: [String:Any], rssi: NSNumber) {
        let name = p.name ?? (d[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        if name.lowercased().contains("obd") || name.lowercased().contains("mx") {
            log("FOUND: \(name)  id=\(p.identifier)  rssi=\(rssi)")
            target = p; p.delegate = self
            c.stopScan(); c.connect(p)
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        log("connected, discovering services…"); p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        log("connect failed: \(error?.localizedDescription ?? "?")")
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        for s in p.services ?? [] {
            log("SERVICE \(s.uuid)")
            p.discoverCharacteristics(nil, for: s)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            var props: [String] = []
            if ch.properties.contains(.read) { props.append("read") }
            if ch.properties.contains(.write) { props.append("write") }
            if ch.properties.contains(.writeWithoutResponse) { props.append("writeNoResp") }
            if ch.properties.contains(.notify) { props.append("notify") }
            log("  CHAR \(ch.uuid)  [\(props.joined(separator: ","))]  (service \(s.uuid))")
        }
    }
}

let d = Discover()
d.cm = CBCentralManager(delegate: d, queue: nil)
RunLoop.current.run(until: Date().addingTimeInterval(15))
log("done")
