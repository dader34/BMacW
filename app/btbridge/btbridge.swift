// btbridge, OBDLink MX+ (Bluetooth SPP) <-> local TCP bridge for macOS.
//
// macOS's /dev/cu.* serial shim for classic-Bluetooth SPP drops the RFCOMM
// channel unreliably. This opens the channel explicitly via IOBluetooth (by
// device address), HOLDS it, and pipes bytes to/from a local TCP socket. Our
// EDIABAS engine's ELM-WiFi interface then connects to 127.0.0.1:<port> and
// talks ELM/STN over it, exactly how the iOS/Android BMW apps hold the link.
//
// Usage:  btbridge <BT-ADDRESS> <TCP-PORT>
//   e.g.  btbridge 00-04-3E-8A-51-7F 35000
//
// Build:  swiftc -O -framework IOBluetooth -framework Foundation btbridge.swift -o btbridge

import Foundation
import IOBluetooth

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: btbridge <bt-address> <tcp-port>\n".data(using: .utf8)!)
    exit(2)
}
let btAddress = args[1]                       // "00-04-3E-8A-51-7F"
let tcpPort = UInt16(args[2]) ?? 35000

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// ---- RFCOMM channel delegate: bridges Bluetooth <-> a connected TCP client ----
final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var rfcomm: IOBluetoothRFCOMMChannel?
    var tcpOut: FileHandle?           // write to TCP client
    let lock = NSLock()

    // bytes arrived from the MX+ -> forward to TCP client
    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data dataPtr: UnsafeMutableRawPointer!, length: Int) {
        let data = Data(bytes: dataPtr, count: length)
        lock.lock(); tcpOut?.write(data); lock.unlock()
    }

    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) {
        log("rfcomm closed"); exit(1)
    }

    // bytes from TCP client -> write to the MX+
    func sendToBt(_ data: Data) {
        guard let ch = rfcomm else { return }
        var bytes = [UInt8](data)
        ch.writeSync(&bytes, length: UInt16(bytes.count))
    }
}

let bridge = Bridge()

// ---- open the RFCOMM (SPP) channel to the MX+ ----
guard let device = IOBluetoothDevice(addressString: btAddress) else {
    log("invalid bt address: \(btAddress)"); exit(1)
}
log("connecting to \(btAddress)…")

// 1) Establish the baseband connection first (RFCOMM open needs this).
let connRes = device.openConnection()
if connRes != kIOReturnSuccess {
    log("openConnection failed: \(connRes), is the MX+ powered (plugged into car) and in range?")
    // continue anyway; some stacks open RFCOMM lazily
}

// 2) Discover the SPP RFCOMM channel ID from the device's SDP record, falling
//    back to common channel IDs (1, then a scan).
func sppChannelID() -> BluetoothRFCOMMChannelID {
    // Serial Port Profile UUID = 0x1101
    let sppUUID = IOBluetoothSDPUUID(uuid16: 0x1101)
    if let rec = device.getServiceRecord(for: sppUUID) {
        var cid: BluetoothRFCOMMChannelID = 0
        if rec.getRFCOMMChannelID(&cid) == kIOReturnSuccess && cid != 0 {
            log("SPP channel from SDP: \(cid)"); return cid
        }
    }
    log("SPP channel not in SDP; trying 1"); return 1
}

var channel: IOBluetoothRFCOMMChannel?
let chId = sppChannelID()
var res = device.openRFCOMMChannelSync(&channel, withChannelID: chId, delegate: bridge)
if res != kIOReturnSuccess || channel == nil {
    // brute-force a few channel IDs if the SDP one failed
    for cid: BluetoothRFCOMMChannelID in [1, 2, 3, 4, 5] where cid != chId {
        res = device.openRFCOMMChannelSync(&channel, withChannelID: cid, delegate: bridge)
        if res == kIOReturnSuccess, channel != nil { log("opened on channel \(cid)"); break }
    }
}
if res != kIOReturnSuccess || channel == nil {
    log("openRFCOMMChannel failed: \(res)"); exit(1)
}
bridge.rfcomm = channel
log("rfcomm channel open")

// ---- accept ONE local TCP client and pump bytes ----
let listenFd = socket(AF_INET, SOCK_STREAM, 0)
var yes: Int32 = 1
setsockopt(listenFd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
var addr = sockaddr_in()
addr.sin_family = sa_family_t(AF_INET)
addr.sin_port = tcpPort.bigEndian
addr.sin_addr.s_addr = inet_addr("127.0.0.1")
let bindRes = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
}
if bindRes != 0 { log("bind failed on port \(tcpPort)"); exit(1) }
listen(listenFd, 1)
log("listening on 127.0.0.1:\(tcpPort)")

DispatchQueue.global().async {
    while true {
        let clientFd = accept(listenFd, nil, nil)
        if clientFd < 0 { continue }
        log("tcp client connected")
        let inHandle = FileHandle(fileDescriptor: clientFd, closeOnDealloc: true)
        bridge.lock.lock(); bridge.tcpOut = inHandle; bridge.lock.unlock()
        // read from TCP client -> BT (blocking loop on this fd)
        while true {
            let chunk = inHandle.availableData
            if chunk.isEmpty { break }
            bridge.sendToBt(chunk)
        }
        log("tcp client disconnected")
        bridge.lock.lock(); bridge.tcpOut = nil; bridge.lock.unlock()
    }
}

// keep the IOBluetooth run loop alive
RunLoop.current.run()
