// ELM/STN over a serial port, for the OBDLink MX+ paired over Bluetooth
// (/dev/cu.OBDLink* on macOS). like EdElmWifiInterface but over a SerialPort
// stream instead of a TCP socket; shared EdElmInterface drives the ELM
// protocol over whatever Stream it gets.
//
// selected by EdInterfaceObd when ComPort starts with "ELM327SERIAL".

using System;
using System.IO.Ports;
using System.Threading;
using EdiabasLib;

namespace EdiabasLib
{
    internal static class EdElmSerialInterface
    {
        public const string PortId = "ELM327SERIAL";
        public static string SerialPortName = string.Empty;   // e.g. /dev/cu.OBDLinkMX36432
        public static int BaudRate = 115200;                  // MX+ Bluetooth SPP default

        public static EdiabasNet Ediabas { get; set; }

        private static SerialPort _serialPort;
        private static EdElmInterface _edElmInterface;
        private static readonly ManualResetEvent TransmitCancelEvent = new ManualResetEvent(false);

        public static bool InterfaceConnect(string port, object parameter)
        {
            if (_serialPort != null && _serialPort.IsOpen) return true;
            try
            {
                TransmitCancelEvent.Reset();
                // form ELM327SERIAL:/dev/cu.OBDLink...[:baud]
                string portData = port.StartsWith(PortId, StringComparison.OrdinalIgnoreCase)
                    ? port.Substring(PortId.Length) : port;
                string dev = SerialPortName;
                int baud = BaudRate;
                if (portData.StartsWith(":"))
                {
                    var parts = portData.Substring(1).Split(':');
                    if (parts.Length > 0 && parts[0].Length > 0) dev = parts[0];
                    if (parts.Length > 1) int.TryParse(parts[1], out baud);
                }
                if (string.IsNullOrEmpty(dev)) { Ediabas?.LogString(EdiabasNet.EdLogLevel.Ifh, "ELM serial: no device"); return false; }

                Ediabas?.LogFormat(EdiabasNet.EdLogLevel.Ifh, "ELM serial connect: {0} @ {1}", dev, baud);
                // baud is nominal on a Bluetooth-SPP port (channel is packetized).
                // generous timeouts: BT round-trips far slower than USB, a 1 ms
                // read timeout starves the ELM reader.
                _serialPort = new SerialPort(dev, baud, Parity.None, 8, StopBits.One)
                {
                    ReadTimeout = 100, WriteTimeout = 2000, Handshake = Handshake.None,
                    DtrEnable = true, RtsEnable = true,
                };
                _serialPort.Open();
                var stream = _serialPort.BaseStream;
                _edElmInterface = new EdElmInterface(Ediabas, stream, stream, TransmitCancelEvent);
                if (!_edElmInterface.Elm327Init())
                {
                    Ediabas?.LogString(EdiabasNet.EdLogLevel.Ifh, "ELM serial: Elm327Init failed");
                    InterfaceDisconnect();
                    return false;
                }
            }
            catch (Exception ex)
            {
                Ediabas?.LogFormat(EdiabasNet.EdLogLevel.Ifh, "ELM serial connect exception: {0}", EdiabasNet.GetExceptionText(ex));
                InterfaceDisconnect();
                return false;
            }
            return true;
        }

        public static bool InterfaceDisconnect()
        {
            bool ok = true;
            try { _edElmInterface?.Dispose(); } catch { ok = false; } finally { _edElmInterface = null; }
            try { if (_serialPort != null) { if (_serialPort.IsOpen) _serialPort.Close(); _serialPort.Dispose(); } }
            catch { ok = false; } finally { _serialPort = null; }
            return ok;
        }

        public static bool InterfaceTransmitCancel(bool cancel)
        {
            if (cancel) TransmitCancelEvent.Set(); else TransmitCancelEvent.Reset();
            return true;
        }

        public static EdInterfaceObd.InterfaceErrorResult InterfaceSetConfig(
            EdInterfaceObd.Protocol protocol, int baudRate, int dataBits,
            EdInterfaceObd.SerialParity parity, bool allowBitBang)
            => EdInterfaceObd.InterfaceErrorResult.NoError;

        public static bool InterfaceSetDtr(bool dtr) => true;
        public static bool InterfaceSetRts(bool rts) => true;
        public static bool InterfaceGetDsr(out bool dsr) { dsr = true; return true; }
        public static bool InterfaceSetBreak(bool enable) => false;
        public static bool InterfaceSetInterByteTime(int time) => true;
        public static bool InterfaceSetCanIds(int canTxId, int canRxId, EdInterfaceObd.CanFlags canFlags) => true;

        public static bool InterfacePurgeInBuffer()
            => _edElmInterface != null && _edElmInterface.InterfacePurgeInBuffer();

        public static bool InterfaceAdapterEcho() => false;
        public static bool InterfaceHasPreciseTimeout() => false;
        public static bool InterfaceHasAutoBaudRate() => false;
        public static bool InterfaceHasAutoKwp1281() => false;
        public static int? InterfaceAdapterVersion() => null;
        public static byte[] InterfaceAdapterSerial() => null;
        public static double? InterfaceAdapterVoltage() => null;
        public static bool InterfaceHasIgnitionStatus() => false;

        public static bool InterfaceSendData(byte[] sendData, int length, bool setDtr, double dtrTimeCorr)
        {
            if (_edElmInterface == null) return false;
            if (_edElmInterface.StreamFailure)
            {
                InterfaceDisconnect();
                if (!InterfaceConnect(SerialPortName, null)) { return false; }
            }
            return _edElmInterface.InterfaceSendData(sendData, length, setDtr, dtrTimeCorr);
        }

        public static bool InterfaceReceiveData(byte[] receiveData, int offset, int length, int timeout, int timeoutTelEnd, EdiabasNet ediabasLog)
            => _edElmInterface != null && _edElmInterface.InterfaceReceiveData(receiveData, offset, length, timeout, timeoutTelEnd, ediabasLog);

        public static bool InterfaceSendPulse(UInt64 dataBits, int length, int pulseWidth, bool setDtr, bool bothLines, int autoKeyByteDelay) => false;
    }
}
