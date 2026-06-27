#!/usr/bin/env python3
"""
menugen.py: convert a raw EDIABAS job list into an English INPA-style functional
menu (JSON). One ECU per run.

Usage:  menugen.py <SGBD_NAME> <jobs.txt>  > menu.json

Pipeline:
  1. drop EDIABAS system jobs (_JOBS, INITIALISIERUNG, ...)
  2. translate job name German -> English (token dict + curated names)
  3. group jobs into INPA functional sections by prefix
  4. flag write/flash/security jobs as danger
"""
import sys, json, re

# EDIABAS system/internal jobs, never surfaced
SYSTEM = {
    "_JOBS","_JOBCOMMENTS","_ARGUMENTS","_RESULTS","_VERSIONINFO","_TABLES","_TABLE",
    "INITIALISIERUNG","ENDE","NORMALER_DATENVERKEHR","DIAGNOSE_AUFRECHT",
    "DIAGNOSE_MODE","DIAGNOSE_ENDE","SENDE_TELEGRAMM",
}

# curated whole-job English names, highest priority
CURATED = {
    "FS_LESEN": "Read fault codes",
    "FS_LESEN_DETAIL": "Read fault codes (detailed)",
    "FS_LESEN_HEX": "Read fault codes (hex)",
    "FS_LESEN_FREEZE_FRAME": "Read fault codes (freeze frame)",
    "FS_LOESCHEN": "Clear fault codes",
    "IDENT": "Identify ECU",
    "IDENT_AIF": "Identify (AIF)",
    "INFO": "ECU info",
    "SERIENNUMMER_LESEN": "Read serial number",
    "STATUS_LESEN": "Read status",
    "CBS_DATEN_LESEN": "Read CBS service data",
    "CBS_RESET": "Reset CBS service",
    "STEUERGERAETE_RESET": "Reset ECU",
    "PRUEFSTEMPEL_LESEN": "Read inspection stamp",
    "PRUEFSTEMPEL_SCHREIBEN": "Write inspection stamp",
    "PRUEFCODE_LESEN": "Read test code",
    "STATUS_OBD": "OBD status",
    "AIF_LESEN": "Read assembly info (AIF)",
    "AIF_SCHREIBEN": "Write assembly info (AIF)",
}

# German -> English tokens, applied token by token
TOKENS = {
    "LESEN":"Read","SCHREIBEN":"Write","LOESCHEN":"Clear","SETZEN":"Set",
    "STATUS":"Status","STEUERN":"Activate","STELLGLIED":"Actuator","TEST":"Test",
    "FEHLER":"Fault","FEHLERSPEICHER":"Fault memory","FS":"Fault",
    "MOTOR":"Engine","DREHZAHL":"RPM","UEBERDREHZAHL":"Overrev",
    "TEMPERATUR":"Temperature","TEMP":"Temp","DRUCK":"Pressure","SPANNUNG":"Voltage",
    "LAMBDA":"Lambda","GEMISCH":"Mixture","ZUENDUNG":"Ignition","EINSPRITZUNG":"Injection",
    "KRAFTSTOFF":"Fuel","LUFT":"Air","ABGAS":"Exhaust","KAT":"Catalyst",
    "KUEHLMITTEL":"Coolant","OEL":"Oil","GANG":"Gear","GETRIEBE":"Transmission",
    "BREMSE":"Brake","RAD":"Wheel","LENKUNG":"Steering","WINKEL":"Angle",
    "SERIENNUMMER":"Serial number","NUMMER":"Number","NR":"No",
    "HARDWARE":"Hardware","SOFTWARE":"Software","VERSION":"Version","DATEN":"Data",
    "REFERENZ":"Reference","PHYSIKALISCHE":"Physical","HW":"HW",
    "FLASH":"Flash","PROGRAMMIER":"Programming","SIGNATUR":"Signature",
    "AUTHENTISIERUNG":"Authentication","ZUFALLSZAHL":"Random number","START":"Start",
    "BLOCKLAENGE":"Block length","ADRESSE":"Address","SPEICHER":"Memory",
    "ZEITEN":"Times","ZEIT":"Time","PARAMETER":"Parameter","BAUDRATE":"Baud rate",
    "RESET":"Reset","MODE":"Mode","SLEEP":"Sleep","SYNC":"Sync","INTERFACETYPE":"Interface type",
    "ACCESS":"Access","TIMING":"Timing","DEFAULT":"Default","VARIANTE":"Variant",
    "PRUEFSTEMPEL":"Inspection stamp","PRUEFCODE":"Test code","ZIF":"ZIF",
    "BACKUP":"Backup","CBS":"CBS","OBD":"OBD","FREEZE":"Freeze","FRAME":"Frame",
    "DETAIL":"Detail","HEX":"Hex","INFO":"Info","IDENT":"Identify","AIF":"AIF",
    "FUSSHEBEL":"Pedal","FUSSHEBELFEHLBETAETIGUNG":"Pedal misuse","FEHLBEDIENUNG":"Misuse",
    "MOMENTEN":"Torque","MOMENT":"Torque","EINGRIFF":"Intervention","EINGRIFFE":"Interventions",
    "ANZAHL":"Count","ZAEHLER":"Counter","MAX":"Max","BETRIEB":"Operation","C":"C",
}

# section grouping by jobname prefix, in display order
def section_for(job):
    j = job.upper()
    if j.startswith("FS_") or "FEHLER" in j:                      return "Faults"
    if j in ("IDENT","INFO","SERIENNUMMER_LESEN") or j.startswith("IDENT"): return "Identity"
    if "IDENT" in j or "VERSION" in j or "_HW_" in j or "HARDWARE" in j or "REFERENZ" in j: return "Identity"
    if j.startswith("STATUS") or j.startswith("MW_") or "MESSWERT" in j:  return "Status"
    if j.startswith("STEUERN") or "STELLGLIED" in j:             return "Activations"
    if "FLASH" in j or "PROGRAMMIER" in j or "AUTHENTISIERUNG" in j or "SIGNATUR" in j: return "Programming"
    if "CBS" in j:                                                return "Service"
    return "Other"

SECTION_ORDER = ["Faults","Status","Activations","Identity","Service","Programming","Other"]
DANGER = re.compile(r"FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|_SETZEN|STEUERN|STELLGLIED")

def translate(job):
    if job in CURATED:
        return CURATED[job]
    parts = job.split("_")
    out = []
    for p in parts:
        out.append(TOKENS.get(p.upper(), p.capitalize() if p.isalpha() else p))
    return " ".join(out)

def build(sgbd, jobs):
    sections = {s: [] for s in SECTION_ORDER}
    for job in jobs:
        if job in SYSTEM:
            continue
        sec = section_for(job)
        sections[sec].append({
            "job": job,
            "label": translate(job),
            "danger": bool(DANGER.search(job.upper())),
        })
    # drop empty sections, keep order
    menu = [{"section": s, "items": sections[s]} for s in SECTION_ORDER if sections[s]]
    return {"sgbd": sgbd, "sections": menu,
            "jobCount": sum(len(s["items"]) for s in menu)}

if __name__ == "__main__":
    sgbd = sys.argv[1]
    jobs = [l.strip() for l in open(sys.argv[2]) if l.strip() and re.match(r"^[A-Z_]", l.strip())]
    print(json.dumps(build(sgbd, jobs), ensure_ascii=False, indent=2))
