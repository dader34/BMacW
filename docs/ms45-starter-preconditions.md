# MS45.1, Why STEUERN_STA (Starter Test) Gets Rejected with 7F-30-22

**Car:** BMW with MS45.1 DME (Bosch, MPC555-class).
**Symptom:** The starter actuator test **STEUERN_STA** is rejected by the DME with
`7F 30 22`, UDS RoutineControl, negative response code **0x22 = conditionsNotCorrect**.
The fuel-pump test **STEUERN_EKP** runs fine, which tells us the DME is simply refusing
because the *vehicle is not in the state it wants* for cranking the starter, not because of
a wiring or tool problem.

This document is the plain-English result of reverse-engineering the DME firmware to find
exactly what it checks.

---

## What the car requires before it will run STEUERN_STA

| # | Requirement | Why (in plain English) | Confidence |
|---|-------------|------------------------|------------|
| 1 | **Be in the extended diagnostic session** (your tool requests the actuator/extended session; INPA/Tool32 do this automatically) | The handler refuses any RoutineControl unless the session equals 5. | **Proven** (firmware checks session == 5; otherwise returns 0x7F) |
| 2 | **Engine must be OFF, not running, RPM = 0** | The DME's master "active actuation permitted" flag drops as soon as the engine is running. You cannot crank the starter test while the engine is already turning. | **Proven gate, inferred meaning** (dominant cause of 7F-30-22 on the starter) |
| 3 | **Ignition fully ON (terminal 15 on)** | The same master permit flag also reflects key/terminal-15 state. Test mode needs the ignition on but the engine not running. | **Proven gate, inferred meaning** |
| 4 | **Immobilizer (EWS) must be released / key accepted** | The starter circuit is EWS-protected; if the rolling-code handshake hasn't completed, the DME will not allow starter actuation. | **Inferred** (part of the same aggregate permit flag) |
| 5 | **No other actuator/routine test currently running** | A separate "routine idle" flag must say no test is active. Stop any prior test (send its `*_ENDE`) first. | **Proven** (flag set when a routine is reset/stopped, cleared when one starts) |
| 6 | **Starter output stage must be electrically healthy** (no open-load, no short to ground) | A dedicated output-stage diagnostic byte forces 0x22 if the starter relay/wire reads open or shorted. | **Proven gate, inferred meaning** |
| 7 | **No conflicting fault lockout / actuator-specific inhibit set** | A secondary enable flag must be set and a fault-inhibit flag must be clear before the starter block will fire. | **Proven** (two extra flags checked only on the starter path) |

**Why EKP works but STA doesn't:** the fuel-pump prime routine takes a shorter path in the
firmware and skips the strict engine-state and starter-output-stage checks. The starter test
additionally demands the engine be stopped and the starter output stage fault-free, so any
of conditions #2, #3, #4, or #6 being wrong produces exactly the `7F 30 22` you're seeing,
while EKP sails through.

---

## What to actually do in the car (recommended sequence)

1. **Battery healthy / charger on.** Cranking tests draw current and a weak battery can
   itself trip the lockout. Put a charger/maintainer on it.
2. **Key in, ignition ON to terminal 15, but do NOT start the engine.** Dash lit up,
   engine not running (RPM must read 0).
3. **Let the immobilizer settle.** Wait a few seconds after ignition-on so the EWS/DME
   handshake completes (no immobilizer warning).
4. **Make sure no other test is active.** If you just ran another actuator test (including
   EKP), stop/cancel it (send its `*_ENDE`) and let the tool return to idle before starting STA.
5. **Gearbox safe:** automatic in **P** (Park); manual in **neutral with clutch pressed** and
   handbrake on. (Belt-and-suspenders, the firmware's hard gate is engine-off, but you don't
   want the car lurching if the starter engages.)
6. **Run STEUERN_STA.** It should now return a positive `70` response.

### If it still returns 7F-30-22
- Confirm the engine truly shows **RPM 0** and is fully stopped.
- Confirm you are still in the **extended session** (re-establish it; some tools time out of it).
- Check for a **starter-circuit electrical fault** (open-load or short on the starter
  control wire/relay), requirement #6 will block the test regardless of how you sequence
  things. Inspect the starter relay and its wiring.
- Clear any stored DME faults, cycle the ignition, and retry.

---

## Firmware evidence (for the record)
- Service-ID dispatcher: `0xd8320` (`cmpwi r3,0x30` at `0xd8358` → `beq 0xd8794`).
- RoutineControl (0x30) handler entry: `0xd8794`. NRC-0x22 emitted at `0xd8834`.
- Session-5 check: `lhz -0x7dd2(r13); cmpwi 5; bne` at `0xd8794`.
- Master actuation-permit flag `-0x3f9d(r13)` (read-only status mirror, ~198 reads / 0 writes)
  checked at `0xd87d8` and in the actuator engine at `0x907c8`/`0x90894`.
- Routine-idle flag `-0x3f7a(r13)` checked at `0xd87e4` (set=1 on reset `0xcaa50`/`0xcaa98`,
  cleared on start `0xcaac4`).
- Actuator precondition engine `0x9070c`: trio `-0x3f9d` (=1), `-0x3f9b` (=1), `-0x3ca2`
  (=0, inverted polarity), plus `-0x2db8` already-active/fault byte and output-stage
  diagnostic `-0x69ec(r2)`; failure → `li r3,0x22; bl <NRC sender>`.

EKP and STA share the same 0x30 handler; selection is index/pointer based
(RAM `0xfff028b0`, index in `-0x7db9(r13)`), **not** a literal routine-ID compare. They
diverge only in which per-actuator condition block runs.

## Confidence summary
- **Proven from disassembly** (firmware literally checks these before emitting 0x22):
  extended session, master actuation-permit flag, routine-idle flag, secondary
  enable/inhibit flag pair, and the output-stage electrical diagnostic.
- **Inferred** (standard M54/MS45 behavior mapped onto the proven flags): the *meaning* of
  the master permit flag = engine-off + terminal-15-on + EWS-released + no fault lockout.
  The flag is a read-only status mirror (never written directly in the image), so its exact
  composition is inferred from known ECU behavior rather than a single explicit instruction.

**Single most likely real-world cause:** the engine was running, or terminal 15 wasn't fully
on / the immobilizer hadn't released, when the test was attempted. Get the car to
key-on / engine-off / immobilizer-released and the starter test should run.
