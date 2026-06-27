using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace EdiabasMac;

// raw EDIABAS job list -> English INPA-style functional menu.
// mirrors tools/menugen.py.
public sealed record MenuItem(string Job, string Label, bool Danger);
public sealed record MenuSection(string Section, List<MenuItem> Items);

public static class MenuGen
{
    static readonly HashSet<string> System = new(StringComparer.OrdinalIgnoreCase)
    {
        "_JOBS","_JOBCOMMENTS","_ARGUMENTS","_RESULTS","_VERSIONINFO","_TABLES","_TABLE",
        "INITIALISIERUNG","ENDE","NORMALER_DATENVERKEHR","DIAGNOSE_AUFRECHT",
        "DIAGNOSE_MODE","DIAGNOSE_ENDE","SENDE_TELEGRAMM",
    };

    static readonly Dictionary<string, string> Curated = new(StringComparer.OrdinalIgnoreCase)
    {
        ["FS_LESEN"] = "Read fault codes",
        ["FS_LESEN_DETAIL"] = "Read fault codes (detailed)",
        ["FS_LESEN_HEX"] = "Read fault codes (hex)",
        ["FS_LESEN_FREEZE_FRAME"] = "Read fault codes (freeze frame)",
        ["FS_LOESCHEN"] = "Clear fault codes",
        ["IDENT"] = "Identify ECU",
        ["INFO"] = "ECU info",
        ["SERIENNUMMER_LESEN"] = "Read serial number",
        ["STATUS_LESEN"] = "Read status",
        ["CBS_DATEN_LESEN"] = "Read CBS service data",
        ["CBS_RESET"] = "Reset CBS service",
        ["STEUERGERAETE_RESET"] = "Reset ECU",
        ["STATUS_OBD"] = "OBD status",
    };

    // German token -> English. core verbs/nouns here; extended at startup from
    // tools/translations/*_tokens.tsv so labels change without a rebuild.
    static readonly Dictionary<string, string> Tokens = LoadTokens(new()
    {
        ["LESEN"]="Read",["SCHREIBEN"]="Write",["LOESCHEN"]="Clear",["SETZEN"]="Set",
        ["STATUS"]="Status",["STEUERN"]="Activate",["STELLGLIED"]="Actuator",["TEST"]="Test",
        ["FEHLER"]="Fault",["FS"]="Fault",["MOTOR"]="Engine",["DREHZAHL"]="RPM",
        ["TEMPERATUR"]="Temperature",["TEMP"]="Temp",["DRUCK"]="Pressure",["SPANNUNG"]="Voltage",
        ["LAMBDA"]="Lambda",["GEMISCH"]="Mixture",["ZUENDUNG"]="Ignition",["EINSPRITZUNG"]="Injection",
        ["KRAFTSTOFF"]="Fuel",["LUFT"]="Air",["ABGAS"]="Exhaust",["KAT"]="Catalyst",
        ["KUEHLMITTEL"]="Coolant",["OEL"]="Oil",["GANG"]="Gear",["GETRIEBE"]="Transmission",
        ["SERIENNUMMER"]="Serial number",["NUMMER"]="Number",["NR"]="number",
        ["HARDWARE"]="Hardware",["SOFTWARE"]="Software",["VERSION"]="Version",["DATEN"]="Data",
        ["REFERENZ"]="Reference",["PHYSIKALISCHE"]="Physical",
        ["FLASH"]="Flash",["PROGRAMMIER"]="Programming",["SIGNATUR"]="Signature",
        ["AUTHENTISIERUNG"]="Authentication",["ZUFALLSZAHL"]="Random number",["START"]="Start",
        ["ADRESSE"]="Address",["SPEICHER"]="Memory",["ZEITEN"]="Times",["ZEIT"]="Time",
        ["PARAMETER"]="Parameter",["BAUDRATE"]="Baud rate",["RESET"]="Reset",["MODE"]="Mode",
        ["VARIANTE"]="Variant",["PRUEFSTEMPEL"]="Inspection stamp",["PRUEFCODE"]="Test code",
        ["BACKUP"]="Backup",["READINESS"]="Readiness",["SYSTEMCHECK"]="System check",
        ["SEK"]="Secondary",["TEV"]="Purge valve",["FGR"]="Cruise control",["SPERREN"]="Lock",
        ["EINGRIFF"]="Intervention",["EINGRIFFE"]="Interventions",["ANZAHL"]="Count",
        ["ZAEHLER"]="Counter",["MAX"]="Max",["BETRIEB"]="Operation",
    });

    // merge every tools/translations/*_tokens.tsv (TOKEN<TAB>English) into baseDict
    static Dictionary<string, string> LoadTokens(Dictionary<string, string> baseDict)
    {
        try
        {
            string dir = FindTranslationsDir();
            if (dir != null)
                foreach (var file in Directory.EnumerateFiles(dir, "*_tokens.tsv"))
                    foreach (var line in File.ReadLines(file))
                    {
                        int tab = line.IndexOf('\t');
                        if (tab <= 0) continue;
                        string tok = line[..tab].Trim();
                        string eng = line[(tab + 1)..].Trim();
                        if (tok.Length > 0 && eng.Length > 0) baseDict[tok] = eng;
                    }
        }
        catch { /* base dict only */ }
        return baseDict;
    }

    static string FindTranslationsDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            string cand = Path.Combine(dir.FullName, "tools", "translations");
            if (Directory.Exists(cand)) return cand;
            dir = dir.Parent;
        }
        return null;
    }

    static readonly string[] Order = { "Faults","Status","Activations","Identity","Service","Programming","Other" };
    static readonly Regex Danger = new("FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|_SETZEN|STEUERN|STELLGLIED", RegexOptions.IgnoreCase);
    // suffix verbs moved to front of label
    static readonly Dictionary<string,string> FrontVerb = new(StringComparer.OrdinalIgnoreCase)
        { ["LESEN"]="Read", ["SCHREIBEN"]="Write", ["LOESCHEN"]="Clear", ["SETZEN"]="Set" };

    static string SectionFor(string job)
    {
        string j = job.ToUpperInvariant();
        if (j.StartsWith("FS_") || j.Contains("FEHLER")) return "Faults";
        if (j is "IDENT" or "INFO" or "SERIENNUMMER_LESEN" || j.StartsWith("IDENT")) return "Identity";
        if (j.Contains("VERSION") || j.Contains("HARDWARE") || j.Contains("REFERENZ") || j.Contains("_HW_")) return "Identity";
        if (j.StartsWith("STATUS") || j.StartsWith("MW_") || j.Contains("MESSWERT")) return "Status";
        if (j.StartsWith("STEUERN") || j.Contains("STELLGLIED")) return "Activations";
        if (j.Contains("FLASH") || j.Contains("PROGRAMMIER") || j.Contains("AUTHENTISIERUNG") || j.Contains("SIGNATUR")) return "Programming";
        if (j.Contains("CBS")) return "Service";
        return "Other";
    }

    static string Translate(string job)
    {
        if (Curated.TryGetValue(job, out var c)) return c;
        var parts = job.Split('_', StringSplitOptions.RemoveEmptyEntries).ToList();
        // trailing Read/Write/Clear/Set verb moves to front
        string front = null;
        if (parts.Count > 1 && FrontVerb.TryGetValue(parts[^1], out var fv)) { front = fv; parts.RemoveAt(parts.Count - 1); }
        var words = parts.Select(p => Tokens.TryGetValue(p, out var t) ? t
                                     : (p.All(char.IsLetter) ? char.ToUpperInvariant(p[0]) + p[1..].ToLowerInvariant() : p));
        string body = string.Join(" ", words);
        return front != null ? $"{front} {body.ToLowerInvariant()}" : body;
    }

    // actuator test: start job plus optional paired stop (_ENDE) job
    public sealed record Activation(string Label, string Start, string Stop, bool Momentary);

    // pair STEUERN_X with STEUERN_X_ENDE into toggleable actuator tests
    public static List<Activation> Activations(IEnumerable<string> jobs)
    {
        var all = jobs.Where(j => j.StartsWith("STEUERN", StringComparison.OrdinalIgnoreCase)
                                  || j.Contains("STELLGLIED", StringComparison.OrdinalIgnoreCase)).ToList();
        var set = new HashSet<string>(all, StringComparer.OrdinalIgnoreCase);
        var stops = new HashSet<string>(all.Where(j => j.EndsWith("_ENDE", StringComparison.OrdinalIgnoreCase)), StringComparer.OrdinalIgnoreCase);
        var result = new List<Activation>();
        foreach (var job in all)
        {
            if (stops.Contains(job)) continue;            // stop jobs folded into their start
            string stop = job + "_ENDE";
            bool hasStop = set.Contains(stop);
            result.Add(new Activation(Translate(job), job, hasStop ? stop : null, !hasStop));
        }
        return result;
    }

    public static List<MenuSection> Build(IEnumerable<string> jobs)
    {
        var buckets = Order.ToDictionary(s => s, _ => new List<MenuItem>());
        foreach (var job in jobs)
        {
            if (System.Contains(job)) continue;
            buckets[SectionFor(job)].Add(new MenuItem(job, Translate(job), Danger.IsMatch(job)));
        }
        return Order.Where(s => buckets[s].Count > 0)
                    .Select(s => new MenuSection(s, buckets[s])).ToList();
    }
}
