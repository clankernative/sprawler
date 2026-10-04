// Sprawler C# analyzer plugin (protocol sprawler.analyzer/1): reads {root, files} JSON on stdin, writes facts JSON on stdout.
// Facts only: projects, per-file role + evidence, symbols, and resolved file→file references.
// Architecture policy lives in the TOML profile, never here.
using System.Collections.Concurrent;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

record Request(string Root, string[] Files);
record Sym(string Kind, string Name, int Line);
record FileOut(string File, string Project, string Role, string[] Evidence, bool Generated,
    int Types, int Functions, int Methods, Sym[] Sample, int Resolved, int Unresolved, JsonObject? Metrics);
record RefOut(string Source, string Target, int Line, int Weight, string[] Relations);
record ProjOut(string Path, string Name, string Sdk, string Kind, bool Restored, bool Test,
    string[] References, string[] Analyzers, string[] Missing, int Files);
record Stats(int Files, int Projects, int Resolved, int Unresolved, int Ambiguous, int Unrestored);
record Result(FileOut[] Files, RefOut[] References, ProjOut[] Projects, Stats Stats, string[] Warnings);

sealed class Proj
{
    public string Full = "", Rel = "", Name = "", Sdk = "", Kind = "library", Assembly = "";
    public bool Restored, Test;
    public List<string> RefFull = new(), AnalyzerFull = new(), Missing = new();
    public HashSet<string> Frameworks = new() { "Microsoft.NETCore.App" };
    public List<string> PackageDlls = new();
    public List<string> Files = new();
    public List<SyntaxTree> Extra = new();
    public CSharpCompilation? Comp;
}

sealed class FileFacts
{
    public string Rel = "";
    public Proj Proj = null!;
    public List<(string Role, string Why)> Cand = new();
    public bool Generated;
    public int Types, Methods, Fns, Resolved, Unresolved;
    public List<Sym> Sample = new();
    public JsonObject? Metrics;
}

static class Program
{
    static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    static int Main(string[] args)
    {
        try
        {
            switch (args.FirstOrDefault())
            {
                case "describe":
                    Console.Out.Write(Protocol.Describe().ToJsonString());
                    return 0;
                case "analyze":
                    var req = JsonNode.Parse(Console.In.ReadToEnd()) ?? throw new InvalidOperationException("empty request");
                    var root = req["root"]?.GetValue<string>() ?? throw new InvalidOperationException("request has no root");
                    var files = req["files"]?.AsArray().Select(f => f!.GetValue<string>()).Where(f => f.EndsWith(".cs")).ToArray() ?? Array.Empty<string>();
                    var result = new Scanner(new Request(root, files)).Run();
                    Console.Out.Write(Protocol.Response(result).ToJsonString());
                    return 0;
                default:
                    Console.Error.WriteLine("usage: sprawler-analyzer-csharp (describe | analyze < request.json)");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"sprawler-analyzer-csharp: {ex.GetType().Name}: {ex.Message}");
            return 2;
        }
    }
}

/// Scanner result → `sprawler.analyzer/1` response. Facts only: project, kind, role (+ evidence).
static class Protocol
{
    const string Name = "sprawler.analyzer/1";

    static JsonArray Arr(IEnumerable<JsonNode?> xs) => new(xs.ToArray());
    static JsonArray Strs(IEnumerable<string> xs) => Arr(xs.Select(x => (JsonNode?)JsonValue.Create(x)));

    public static JsonObject Describe() => new()
    {
        ["protocol"] = Name, ["name"] = "csharp", ["version"] = "0.3.0", ["languages"] = Strs(new[] { "csharp" }),
        ["claims"] = new JsonObject { ["extensions"] = Strs(new[] { ".cs" }) },
        ["precision"] = "semantic", ["facts"] = Strs(new[] { "project", "kind", "role" }),
        ["requires"] = Arr(new JsonNode?[] { new JsonObject {
            ["tool"] = "dotnet", ["check"] = Strs(new[] { "dotnet", "--version" }),
            ["install"] = "https://dotnet.microsoft.com/download (then `dotnet restore` your solution for full resolution)" } }),
    };

    public static JsonObject Response(Result r)
    {
        var kinds = r.Projects.ToDictionary(p => p.Name, p => p.Kind);
        var modules = new JsonArray();
        foreach (var f in r.Files)
        {
            var m = new JsonObject
            {
                ["id"] = f.File, ["path"] = f.File, ["lang"] = "cs",
                ["symbols"] = new JsonObject { ["types"] = f.Types, ["functions"] = f.Functions, ["methods"] = f.Methods },
                ["sample"] = Arr(f.Sample.Select(s => (JsonNode?)new JsonArray(s.Kind, s.Name, s.Line))),
                ["facts"] = new JsonObject { ["role"] = f.Role, ["project"] = f.Project, ["kind"] = kinds.GetValueOrDefault(f.Project, "loose") },
                ["evidence"] = Strs(f.Evidence), ["generated"] = f.Generated,
                ["resolution"] = new JsonArray(f.Resolved, f.Unresolved),
            };
            if (f.Metrics is not null) m["metrics"] = f.Metrics;
            modules.Add(m);
        }
        foreach (var p in r.Projects)
            modules.Add(new JsonObject
            {
                ["id"] = p.Path, ["path"] = p.Path, ["lang"] = "csproj", ["name"] = p.Name, ["loc"] = 0,
                ["symbols"] = new JsonObject { ["types"] = 0, ["functions"] = 0, ["methods"] = 0 }, ["sample"] = new JsonArray(),
                ["facts"] = new JsonObject { ["role"] = "project", ["project"] = p.Name, ["kind"] = p.Kind },
                ["evidence"] = Strs(new[] { $"{p.Kind} project · {(p.Sdk.Length > 0 ? p.Sdk : "no SDK")}" + (p.Restored ? "" : " · not restored") }),
                ["test"] = p.Test, ["project_files"] = p.Files,
            });
        var edges = new JsonArray();
        var declared = new JsonArray();
        foreach (var p in r.Projects)
            foreach (var t in p.References)
            {
                edges.Add(new JsonObject { ["source"] = p.Path, ["target"] = t, ["relations"] = Strs(new[] { "project_reference" }), ["weight"] = 1, ["line"] = null });
                declared.Add(new JsonArray(p.Path, t));
            }
        foreach (var e in r.References)
            edges.Add(new JsonObject { ["source"] = e.Source, ["target"] = e.Target, ["relations"] = Strs(e.Relations), ["weight"] = e.Weight, ["line"] = e.Line });
        var s = r.Stats;
        return new JsonObject
        {
            ["protocol"] = Name, ["modules"] = modules, ["edges"] = edges, ["declared"] = declared,
            ["unknown"] = new JsonObject { ["unresolved"] = 0, ["dropped"] = 0, ["phantoms"] = new JsonArray() },
            ["resolution"] = new JsonObject
            {
                ["lang"] = "cs", ["resolved"] = s.Resolved, ["unresolved"] = s.Unresolved, ["unrestored"] = s.Unrestored,
                ["projects"] = s.Projects, ["failed"] = false,
            },
            ["externals"] = new JsonArray(),
            ["stats"] = new JsonObject
            {
                ["files"] = s.Files, ["projects"] = s.Projects, ["resolved"] = s.Resolved, ["unresolved"] = s.Unresolved,
                ["ambiguous"] = s.Ambiguous, ["unrestored"] = s.Unrestored, ["references"] = r.References.Length,
                ["analyzerReferences"] = r.Projects.Sum(p => p.Analyzers.Length),
            },
            ["warnings"] = Strs(r.Warnings),
        };
    }
}

sealed class Scanner
{
    // lower index wins when a file has several candidate roles
    static readonly string[] Priority = { "test", "migration", "composition", "endpoint", "ui", "worker", "persistence",
        "integration", "service", "entity", "config", "contract", "abstraction", "util", "model", "code" };
    static readonly HashSet<string> TestPkgs = new(StringComparer.OrdinalIgnoreCase)
        { "xunit", "xunit.v3", "NUnit", "MSTest.TestFramework", "MSTest", "TUnit", "Microsoft.NET.Test.Sdk" };
    static readonly Regex TestName = new(@"\.(Tests?|IntegrationTests?|UnitTests?|Specs?|Tests\.Integration)$", RegexOptions.IgnoreCase);
    static readonly Regex MapVerb = new(@"^Map(Get|Post|Put|Delete|Patch|Methods|Group|Hub|GrpcService|Fallback)$");
    static readonly string[] DiHosts = { "IServiceCollection", "IHostApplicationBuilder", "WebApplicationBuilder", "IHostBuilder", "IApplicationBuilder", "WebApplication" };
    static readonly string[] RouteHosts = { "IEndpointRouteBuilder", "RouteGroupBuilder" };

    readonly string root;
    readonly string[] files;
    readonly List<string> warnings = new();
    readonly Dictionary<string, string?> owner = new(StringComparer.Ordinal);
    readonly Dictionary<string, Proj> projects = new(StringComparer.Ordinal);
    readonly Dictionary<string, FileFacts> facts = new(StringComparer.Ordinal);
    readonly ConcurrentDictionary<string, MetadataReference?> mdCache = new(StringComparer.Ordinal);
    readonly Dictionary<string, string> relOfFull = new(StringComparer.Ordinal);
    readonly string dotnetRoot;
    int ambiguous;
    static readonly CSharpParseOptions Parse = new CSharpParseOptions(LanguageVersion.Preview)
        .WithPreprocessorSymbols("DEBUG", "TRACE", "NET", "NETCOREAPP", "NET8_0_OR_GREATER", "NET9_0_OR_GREATER", "NET10_0_OR_GREATER");

    public Scanner(Request r)
    {
        root = Path.GetFullPath(r.Root).TrimEnd(Path.DirectorySeparatorChar);
        files = r.Files.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        // .../shared/Microsoft.NETCore.App/<ver>/System.Private.CoreLib.dll → dotnet root
        var rt = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } d && Directory.Exists(Path.Combine(d, "packs"))
            ? d : Path.GetFullPath(Path.Combine(rt, "..", "..", ".."));
    }

    string Rel(string full) => Path.GetRelativePath(root, full).Replace(Path.DirectorySeparatorChar, '/');

    string? OwnerOf(string dir)
    {
        var visited = new List<string>();
        string? found = null;
        while (dir.Length >= root.Length && (dir == root || dir.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
        {
            if (owner.TryGetValue(dir, out var cached)) { found = cached; break; }
            visited.Add(dir);
            var cs = Directory.GetFiles(dir, "*.csproj").Order(StringComparer.Ordinal).FirstOrDefault();
            if (cs is not null) { found = cs; break; }
            if (dir == root) break;
            dir = Path.GetDirectoryName(dir)!;
        }
        foreach (var v in visited) owner[v] = found;
        return found;
    }

    public Result Run()
    {
        var orphans = new List<string>();
        foreach (var rel in files)
        {
            var full = Path.GetFullPath(Path.Combine(root, rel));
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(full)) continue;
            relOfFull[full] = rel;
            var cs = OwnerOf(Path.GetDirectoryName(full)!);
            if (cs is null) { orphans.Add(rel); continue; }
            if (!projects.TryGetValue(cs, out var p)) projects[cs] = p = Load(cs);
            p.Files.Add(rel);
        }
        if (orphans.Count > 0)
        {
            var loose = new Proj { Full = "", Rel = "", Name = "(no project)", Kind = "loose", Assembly = "SprawlerLoose" };
            loose.Frameworks.Add("Microsoft.AspNetCore.App");
            loose.Files.AddRange(orphans);
            projects[""] = loose;
            warnings.Add($"{orphans.Count} C# file(s) are not under any .csproj; bound without project references");
        }

        // parse
        var trees = new ConcurrentDictionary<string, SyntaxTree>(StringComparer.Ordinal);
        Parallel.ForEach(relOfFull, kv =>
            trees[kv.Value] = CSharpSyntaxTree.ParseText(File.ReadAllText(kv.Key), Parse, kv.Key));

        // topological order over loaded projects (reference cycles are broken, and reported)
        var order = new List<Proj>();
        var state = new Dictionary<Proj, int>();
        void Visit(Proj p)
        {
            if (state.TryGetValue(p, out var s)) { if (s == 1) warnings.Add($"project reference cycle through {p.Name}"); return; }
            state[p] = 1;
            foreach (var r in p.RefFull)
                if (projects.TryGetValue(r, out var q)) Visit(q);
                else p.Missing.Add(Rel(r));
            state[p] = 2;
            order.Add(p);
        }
        foreach (var p in projects.Values.OrderBy(p => p.Rel, StringComparer.Ordinal)) Visit(p);

        var closure = new Dictionary<Proj, List<Proj>>();
        foreach (var p in order)
        {
            var set = new List<Proj>();
            foreach (var r in p.RefFull)
                if (projects.TryGetValue(r, out var q) && closure.ContainsKey(q))
                    foreach (var x in closure[q].Append(q)) if (!set.Contains(x)) set.Add(x);
            closure[p] = set;
        }

        // compile
        var opts = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
            nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true,
            metadataImportOptions: MetadataImportOptions.All);
        foreach (var p in order)
        {
            var refs = new List<MetadataReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var dll in p.PackageDlls.Concat(closure[p].SelectMany(q => q.PackageDlls)))
                if (seen.Add(Path.GetFileName(dll)) && Md(dll) is { } m) refs.Add(m);
            var fws = new HashSet<string>(p.Frameworks.Concat(closure[p].SelectMany(q => q.Frameworks)));
            foreach (var fw in fws)
                foreach (var dll in FrameworkDlls(fw))
                    if (seen.Add(Path.GetFileName(dll)) && Md(dll) is { } m) refs.Add(m);
            foreach (var q in closure[p]) if (q.Comp is not null) refs.Add(q.Comp.ToMetadataReference());
            var own = p.Files.Where(trees.ContainsKey).Select(f => trees[f]).Concat(p.Extra);
            p.Comp = CSharpCompilation.Create(p.Assembly, own, refs, opts);
        }

        foreach (var p in projects.Values)
            foreach (var f in p.Files) facts[f] = new FileFacts { Rel = f, Proj = p };

        // pass 1: declarations, roles, DbSet entities
        var entities = new ConcurrentBag<(ISymbol? Sym, string Name, string Ctx, Proj Proj)>();
        Parallel.ForEach(facts.Values, ff =>
        {
            if (trees.TryGetValue(ff.Rel, out var t)) Declarations(ff, t, entities);
        });
        foreach (var (sym, name, ctx, proj) in entities)
        {
            var file = sym is not null ? FileOf(sym) : null;
            if (file is null)
            {
                var hits = facts.Values.Where(f => f.Proj == proj && f.Sample.Any(s => s.Kind == "type" && s.Name == name)).ToList();
                if (hits.Count == 1) file = hits[0].Rel;
            }
            if (file is not null && facts.TryGetValue(file, out var ef))
                lock (ef) ef.Cand.Add(("entity", $"DbSet<{name}> in {ctx}"));
        }

        // pass 2: references
        var edges = new ConcurrentDictionary<(string, string), (int Line, int W, HashSet<string> Rel)>();
        Parallel.ForEach(facts.Values, ff =>
        {
            if (!trees.TryGetValue(ff.Rel, out var t) || ff.Proj.Comp is null) return;
            var local = References(ff, t);
            foreach (var kv in local)
                edges.AddOrUpdate(kv.Key, kv.Value, (_, old) =>
                {
                    lock (old.Rel) old.Rel.UnionWith(kv.Value.Rel);
                    return (Math.Min(old.Line, kv.Value.Line), old.W + kv.Value.W, old.Rel);
                });
        });

        foreach (var p in projects.Values.Where(p => !p.Restored && p.Full != ""))
            ;
        var unrestored = projects.Values.Count(p => p.Full != "" && !p.Restored);
        if (unrestored > 0)
            warnings.Add($"{unrestored} C# project(s) have no obj/project.assets.json (not restored); NuGet types in them are unresolved — run `dotnet restore` for a fuller map");
        foreach (var p in projects.Values.Where(p => p.Missing.Count > 0))
            warnings.Add($"{p.Name} references project(s) outside the scan: {string.Join(", ", p.Missing.Take(4))}{(p.Missing.Count > 4 ? ", …" : "")}");

        var fileOut = facts.Values.OrderBy(f => f.Rel, StringComparer.Ordinal).Select(Finish).ToArray();
        var refOut = edges.OrderBy(e => e.Key.Item1, StringComparer.Ordinal).ThenBy(e => e.Key.Item2, StringComparer.Ordinal)
            .Select(e => new RefOut(e.Key.Item1, e.Key.Item2, e.Value.Line, e.Value.W, e.Value.Rel.Order().ToArray())).ToArray();
        var projOut = projects.Values.Where(p => p.Full != "").OrderBy(p => p.Rel, StringComparer.Ordinal)
            .Select(p => new ProjOut(p.Rel, p.Name, p.Sdk, p.Kind, p.Restored, p.Test,
                p.RefFull.Where(projects.ContainsKey).Select(Rel).Order().ToArray(),
                p.AnalyzerFull.Where(projects.ContainsKey).Select(Rel).Order().ToArray(),
                p.Missing.Distinct().Order().ToArray(), p.Files.Count)).ToArray();
        var stats = new Stats(fileOut.Length, projOut.Length, facts.Values.Sum(f => f.Resolved),
            facts.Values.Sum(f => f.Unresolved), ambiguous, unrestored);
        return new Result(fileOut, refOut, projOut, stats, warnings.Distinct().ToArray());
    }

    FileOut Finish(FileFacts f)
    {
        string role; string[] why;
        if (f.Proj.Test) { role = "test"; why = new[] { $"{f.Proj.Name} is a test project" }; }
        else if (f.Cand.Count == 0) { role = "code"; why = new[] { "no recognised role signal" }; }
        else
        {
            var best = f.Cand.Select(c => c.Role).MinBy(r => Array.IndexOf(Priority, r) is var i && i < 0 ? 99 : i)!;
            role = best;
            why = f.Cand.Where(c => c.Role == best).Select(c => c.Why).Distinct().Take(4).ToArray();
        }
        if (role == "migration") f.Generated = true;
        return new FileOut(f.Rel, f.Proj.Name, role, why, f.Generated, f.Types, f.Fns, f.Methods,
            f.Sample.OrderBy(s => s.Line).Take(60).ToArray(), f.Resolved, f.Unresolved, f.Metrics);
    }

    // ── project loading ─────────────────────────────────────────────────────
    static XDocument? LoadXml(string path) { try { return XDocument.Load(path); } catch { return null; } }
    static IEnumerable<XElement> El(XDocument? d, string name) => d?.Descendants().Where(e => e.Name.LocalName == name) ?? Enumerable.Empty<XElement>();
    static string? Prop(XDocument? d, string name) => El(d, name).Select(e => e.Value.Trim()).LastOrDefault(v => v.Length > 0);

    Proj Load(string csproj)
    {
        var dir = Path.GetDirectoryName(csproj)!;
        var p = new Proj { Full = csproj, Rel = Rel(csproj), Name = Path.GetFileNameWithoutExtension(csproj) };
        var doc = LoadXml(csproj);
        if (doc is null) warnings.Add($"could not parse {p.Rel}");
        var chain = new List<XDocument>();   // Directory.Build.props/targets, nearest first
        for (var d = dir; d is not null && (d == root || d.StartsWith(root + Path.DirectorySeparatorChar)); d = Path.GetDirectoryName(d))
        {
            foreach (var n in new[] { "Directory.Build.props", "Directory.Build.targets" })
                if (File.Exists(Path.Combine(d, n)) && LoadXml(Path.Combine(d, n)) is { } x) chain.Add(x);
            if (d == root) break;
        }
        string? P(string name) => Prop(doc, name) ?? chain.Select(c => Prop(c, name)).FirstOrDefault(v => v is not null);

        var sdks = new List<string>();
        if (doc?.Root?.Attribute("Sdk")?.Value is { } s) sdks.AddRange(s.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        sdks.AddRange(El(doc, "Sdk").Select(e => e.Attribute("Name")?.Value ?? "").Where(v => v.Length > 0));
        p.Sdk = string.Join(";", sdks.Select(x => x.Split('/')[0]));

        foreach (var pr in El(doc, "ProjectReference"))
        {
            var inc = pr.Attribute("Include")?.Value;
            if (string.IsNullOrWhiteSpace(inc) || inc.Contains("$(")) continue;
            var target = Path.GetFullPath(Path.Combine(dir, inc.Replace('\\', '/')));
            var output = pr.Attribute("ReferenceOutputAssembly")?.Value ?? pr.Elements().FirstOrDefault(e => e.Name.LocalName == "ReferenceOutputAssembly")?.Value;
            var outItem = pr.Attribute("OutputItemType")?.Value ?? "";
            if (string.Equals(output, "false", StringComparison.OrdinalIgnoreCase) || outItem.Equals("Analyzer", StringComparison.OrdinalIgnoreCase))
                p.AnalyzerFull.Add(target);
            else p.RefFull.Add(target);
        }
        var pkgs = El(doc, "PackageReference").Select(e => e.Attribute("Include")?.Value ?? "").Where(v => v.Length > 0).ToList();
        var isTest = Prop(doc, "IsTestProject");  // csproj only: props often set it conditionally
        p.Test = string.Equals(isTest, "true", StringComparison.OrdinalIgnoreCase) || pkgs.Any(TestPkgs.Contains) || TestName.IsMatch(p.Name);
        var outputType = (P("OutputType") ?? "").ToLowerInvariant();
        bool web = p.Sdk.Contains("Microsoft.NET.Sdk.Web") || p.Sdk.Contains("Microsoft.NET.Sdk.Razor") || p.Sdk.Contains("BlazorWebAssembly");
        p.Kind = p.Test ? "test"
            : p.Sdk.Contains("Aspire.AppHost") || pkgs.Any(x => x.StartsWith("Aspire.Hosting.AppHost")) ? "apphost"
            : outputType is "exe" or "winexe" ? (web ? "web" : "exe")
            : outputType == "library" ? "library"
            : p.Sdk.Contains("Microsoft.NET.Sdk.Worker") ? "worker"
            : web ? "web" : "library";
        if (web) p.Frameworks.Add("Microsoft.AspNetCore.App");
        foreach (var fr in El(doc, "FrameworkReference").Select(e => e.Attribute("Include")?.Value).Where(v => v is not null)) p.Frameworks.Add(fr!);
        var an = Prop(doc, "AssemblyName");
        p.Assembly = an is null || an.Contains("$(") ? p.Name : an;

        var assets = Path.Combine(dir, "obj", "project.assets.json");
        if (File.Exists(assets))
        {
            try { ReadAssets(p, assets); p.Restored = true; }
            catch (Exception e) { warnings.Add($"could not read {Rel(assets)}: {e.Message}"); }
        }

        // generated GlobalUsings / AssemblyInfo from the newest obj/<cfg>/<tfm> build, else computed defaults
        var objDir = Path.Combine(dir, "obj");
        string? latest(string pattern) => Directory.Exists(objDir)
            ? Directory.EnumerateFiles(objDir, pattern, SearchOption.AllDirectories).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault()
            : null;
        var gu = latest("*.GlobalUsings.g.cs");
        var usings = gu is not null ? File.ReadAllText(gu) : ComputeUsings(p, doc, chain, P("ImplicitUsings"), web);
        p.Extra.Add(CSharpSyntaxTree.ParseText(usings, Parse, Path.Combine(dir, "obj", "__sprawler_usings.g.cs")));
        if (latest("*.AssemblyInfo.cs") is { } ai)
            p.Extra.Add(CSharpSyntaxTree.ParseText(File.ReadAllText(ai), Parse, ai));
        return p;
    }

    void ReadAssets(Proj p, string path)
    {
        using var js = JsonDocument.Parse(File.ReadAllText(path));
        var r = js.RootElement;
        var folders = r.TryGetProperty("packageFolders", out var pf) ? pf.EnumerateObject().Select(o => o.Name).ToList() : new();
        if (r.TryGetProperty("project", out var proj) && proj.TryGetProperty("frameworks", out var fws))
            foreach (var fw in fws.EnumerateObject())
                if (fw.Value.TryGetProperty("frameworkReferences", out var frs))
                    foreach (var f in frs.EnumerateObject()) p.Frameworks.Add(f.Name);
        if (!r.TryGetProperty("targets", out var targets)) return;
        var target = targets.EnumerateObject().FirstOrDefault(t => !t.Name.Contains('/'));
        if (target.Value.ValueKind != JsonValueKind.Object) return;
        var libs = r.TryGetProperty("libraries", out var l) ? l : default;
        foreach (var lib in target.Value.EnumerateObject())
        {
            if (lib.Value.TryGetProperty("type", out var ty) && ty.GetString() == "project") continue;
            if (!lib.Value.TryGetProperty("compile", out var compile)) continue;
            string? libPath = null;
            if (libs.ValueKind == JsonValueKind.Object && libs.TryGetProperty(lib.Name, out var le) && le.TryGetProperty("path", out var lp)) libPath = lp.GetString();
            libPath ??= lib.Name.ToLowerInvariant();
            foreach (var c in compile.EnumerateObject())
            {
                if (c.Name.EndsWith("/_._")) continue;
                foreach (var folder in folders)
                {
                    var full = Path.Combine(folder, libPath, c.Name);
                    if (File.Exists(full)) { p.PackageDlls.Add(full); break; }
                }
            }
        }
    }

    static string ComputeUsings(Proj p, XDocument? doc, List<XDocument> chain, string? implicitUsings, bool web)
    {
        var list = new List<string>();
        if (string.Equals(implicitUsings, "enable", StringComparison.OrdinalIgnoreCase) || string.Equals(implicitUsings, "true", StringComparison.OrdinalIgnoreCase))
        {
            list.AddRange(new[] { "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks" });
            if (web) list.AddRange(new[] { "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http",
                "Microsoft.AspNetCore.Routing", "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging" });
            if (p.Sdk.Contains("Worker")) list.AddRange(new[] { "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging" });
        }
        var lines = new List<string>();
        foreach (var d in chain.AsEnumerable().Reverse().Append(doc))
            foreach (var u in El(d, "Using"))
            {
                if (u.Attribute("Remove")?.Value is { } rm) { list.Remove(rm); continue; }
                var inc = u.Attribute("Include")?.Value;
                if (string.IsNullOrWhiteSpace(inc)) continue;
                if (u.Attribute("Alias")?.Value is { } alias) lines.Add($"global using {alias} = global::{inc};");
                else if (string.Equals(u.Attribute("Static")?.Value, "true", StringComparison.OrdinalIgnoreCase)) lines.Add($"global using static global::{inc};");
                else list.Add(inc);
            }
        return string.Join("\n", list.Distinct().Select(n => $"global using global::{n};").Concat(lines));
    }

    readonly ConcurrentDictionary<string, string[]> fwCache = new();
    string[] FrameworkDlls(string fw) => fwCache.GetOrAdd(fw, name =>
    {
        var pack = Path.Combine(dotnetRoot, "packs", name + ".Ref");
        static Version V(string s) => Version.TryParse(s.Split('-')[0], out var v) ? v : new Version(0, 0);
        if (Directory.Exists(pack))
        {
            var ver = Directory.GetDirectories(pack).OrderByDescending(d => V(Path.GetFileName(d))).FirstOrDefault();
            var refDir = ver is null ? null : Path.Combine(ver, "ref");
            if (refDir is not null && Directory.Exists(refDir))
            {
                var tfm = Directory.GetDirectories(refDir).OrderByDescending(d => V(Path.GetFileName(d).TrimStart('n', 'e', 't'))).FirstOrDefault();
                if (tfm is not null) return Directory.GetFiles(tfm, "*.dll");
            }
        }
        var shared = Path.Combine(dotnetRoot, "shared", name);
        if (Directory.Exists(shared))
        {
            var ver = Directory.GetDirectories(shared).OrderByDescending(d => V(Path.GetFileName(d))).FirstOrDefault();
            if (ver is not null) return Directory.GetFiles(ver, "*.dll");
        }
        if (name == "Microsoft.NETCore.App")
            return ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        lock (warnings) warnings.Add($"framework {name} not found under {dotnetRoot}");
        return Array.Empty<string>();
    });

    MetadataReference? Md(string path) => mdCache.GetOrAdd(path, p =>
    {
        try
        {
            using var fs = File.OpenRead(p);
            using var pe = new PEReader(fs);
            return pe.HasMetadata ? MetadataReference.CreateFromFile(p) : null;
        }
        catch { return null; }
    });

    // ── pass 1 ──────────────────────────────────────────────────────────────
    void Declarations(FileFacts f, SyntaxTree tree, ConcurrentBag<(ISymbol?, string, string, Proj)> entities)
    {
        var model = f.Proj.Comp!.GetSemanticModel(tree);
        var rootNode = (CompilationUnitSyntax)tree.GetRoot();
        var file = Path.GetFileName(f.Rel);
        var head = rootNode.GetLeadingTrivia().ToFullString();
        f.Generated = head.Contains("<auto-generated", StringComparison.OrdinalIgnoreCase)
            || Regex.IsMatch(file, @"\.(g|designer|generated)\.cs$", RegexOptions.IgnoreCase);
        if (file is "Program.cs" or "Startup.cs" || rootNode.Members.OfType<GlobalStatementSyntax>().Any())
            f.Cand.Add(("composition", file == "Startup.cs" ? "Startup class" : "application entry point"));

        f.Metrics = Health.Measure(tree);
        bool mapsRoutes = false;
        foreach (var n in rootNode.DescendantNodes())
        {
            switch (n)
            {
                case BaseTypeDeclarationSyntax td:
                    f.Types++;
                    Add(f, "type", td.Identifier.Text, td);
                    if (td.Parent is BaseNamespaceDeclarationSyntax or CompilationUnitSyntax)
                    {
                        var sym = model.GetDeclaredSymbol(td) as INamedTypeSymbol;
                        var (role, why) = TypeRole(td, sym, f.Rel);
                        if (role != "code") f.Cand.Add((role, why));
                        if (sym is not null && Bases(sym).Any(b => b.EndsWith("DbContext")))
                            CollectDbSets(td, model, sym.Name, f.Proj, entities);
                    }
                    break;
                case DelegateDeclarationSyntax dd: f.Types++; Add(f, "type", dd.Identifier.Text, dd); break;
                case MethodDeclarationSyntax md: f.Methods++; Add(f, "method", md.Identifier.Text, md); break;
                case ConstructorDeclarationSyntax cd: f.Methods++; Add(f, "method", cd.Identifier.Text, cd); break;
                case LocalFunctionStatementSyntax lf: f.Fns++; Add(f, "fn", lf.Identifier.Text, lf); break;
                case InvocationExpressionSyntax inv when !mapsRoutes:
                    var nm = inv.Expression switch { MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text, IdentifierNameSyntax id => id.Identifier.Text, _ => "" };
                    if (MapVerb.IsMatch(nm)) { mapsRoutes = true; f.Cand.Add(("endpoint", $"maps HTTP routes ({nm})")); }
                    break;
            }
        }
    }

    static void Add(FileFacts f, string kind, string name, SyntaxNode n)
    {
        if (f.Sample.Count < 60) f.Sample.Add(new Sym(kind, name, n.GetLocation().GetLineSpan().StartLinePosition.Line + 1));
    }

    static IEnumerable<string> Bases(INamedTypeSymbol s)
    {
        for (var b = s.BaseType; b is not null && b.SpecialType != SpecialType.System_Object; b = b.BaseType) yield return b.Name;
    }

    static string Simple(TypeSyntax t) => t switch
    {
        QualifiedNameSyntax q => Simple(q.Right),
        AliasQualifiedNameSyntax a => a.Name.Identifier.Text,
        GenericNameSyntax g => g.Identifier.Text,
        IdentifierNameSyntax i => i.Identifier.Text,
        _ => t.ToString(),
    };

    static (string, string) TypeRole(BaseTypeDeclarationSyntax td, INamedTypeSymbol? sym, string rel)
    {
        var name = td.Identifier.Text;
        var bases = new HashSet<string>(StringComparer.Ordinal);
        var ifaces = new HashSet<string>(StringComparer.Ordinal);
        if (sym is not null)
        {
            foreach (var b in Bases(sym)) bases.Add(b);
            foreach (var i in sym.AllInterfaces) ifaces.Add(i.Name);
        }
        foreach (var bt in td.BaseList?.Types ?? default) { var n = Simple(bt.Type); bases.Add(n); ifaces.Add(n); }
        var attrs = td.AttributeLists.SelectMany(a => a.Attributes).Select(a => Simple(a.Name).Replace("Attribute", "")).ToHashSet();
        bool B(params string[] xs) => xs.Any(bases.Contains);
        bool I(params string[] xs) => xs.Any(ifaces.Contains);
        bool Ends(params string[] xs) => xs.Any(x => name.EndsWith(x, StringComparison.Ordinal) && name.Length > x.Length);

        if (B("Migration", "ModelSnapshot")) return ("migration", "EF Core migration");
        if (B("ControllerBase", "Controller")) return ("endpoint", $"derives from {(bases.Contains("ControllerBase") ? "ControllerBase" : "Controller")}");
        if (attrs.Contains("ApiController")) return ("endpoint", "[ApiController]");
        if (B("Hub")) return ("endpoint", "SignalR hub");
        if (B("Endpoint", "EndpointWithoutRequest") || I("IEndpoint", "ICarterModule")) return ("endpoint", "endpoint class");
        if (B("ComponentBase", "LayoutComponentBase", "OwningComponentBase", "PageModel") || rel.EndsWith(".razor.cs") || rel.EndsWith(".cshtml.cs"))
            return ("ui", "UI component / page");
        if (B("BackgroundService") || I("IHostedService")) return ("worker", "hosted background service");
        if (I("IConsumer", "IJob", "IInvocable")) return ("worker", "message consumer / scheduled job");
        if (td is TypeDeclarationSyntax && Ends("Worker", "Consumer", "Job")) return ("worker", $"name ends in {name[^Math.Min(8, name.Length)..]}");
        if (B("DbContext", "IdentityDbContext")) return ("persistence", "EF Core DbContext");
        if (I("IEntityTypeConfiguration", "IDesignTimeDbContextFactory")) return ("persistence", "EF Core configuration");
        if (td is ClassDeclarationSyntax && Ends("Repository", "Repo", "Dao")) return ("persistence", "repository class");
        if (td is ClassDeclarationSyntax cls && cls.Modifiers.Any(SyntaxKind.StaticKeyword))
        {
            var ext = ExtensionTarget(cls);
            if (ext is not null && RouteHosts.Contains(ext)) return ("endpoint", $"extends {ext} (route mapping)");
            if (ext is not null && DiHosts.Contains(ext)) return ("composition", $"extends {ext} (DI / host wiring)");
        }
        if (td is InterfaceDeclarationSyntax) return ("abstraction", "interface");
        if (td is EnumDeclarationSyntax) return ("model", "enum");
        if (td is ClassDeclarationSyntax && Ends("Client", "Gateway", "Adapter", "Proxy", "Connector")) return ("integration", "external client / adapter");
        if (td is TypeDeclarationSyntax tds && tds.Members.OfType<ConstructorDeclarationSyntax>()
                .Any(c => c.ParameterList.Parameters.Any(p => p.Type is not null && Simple(p.Type) is "HttpClient" or "IHttpClientFactory")))
            return ("integration", "takes an HttpClient");
        if (I("IRequestHandler", "INotificationHandler", "ICommandHandler", "IQueryHandler", "IValidator")) return ("service", "handler / validator");
        if (td is ClassDeclarationSyntax && Ends("Service", "Handler", "Manager", "Processor", "Orchestrator", "Coordinator", "Engine", "Validator", "Resolver", "Calculator", "Provider"))
            return ("service", "service-style name");
        if (Ends("Options", "Settings", "Configuration", "Config")) return ("config", "options / settings type");
        if (Ends("Request", "Response", "Dto", "DTO", "Command", "Query", "Payload", "ViewModel", "Contract")) return ("contract", "request / response / DTO name");
        if (td is ClassDeclarationSyntax sc && sc.Modifiers.Any(SyntaxKind.StaticKeyword) && Ends("Extensions", "Helper", "Helpers", "Utils", "Utilities"))
            return ("util", "static helper");
        if (td is RecordDeclarationSyntax || td is StructDeclarationSyntax) return ("model", "record / struct");
        if (td is ClassDeclarationSyntax c2 && !c2.Members.OfType<MethodDeclarationSyntax>().Any()) return ("model", "data-only class");
        return ("code", "");
    }

    static string? ExtensionTarget(ClassDeclarationSyntax cls) => cls.Members.OfType<MethodDeclarationSyntax>()
        .Select(m => m.ParameterList.Parameters.FirstOrDefault())
        .Where(p => p is not null && p.Modifiers.Any(SyntaxKind.ThisKeyword) && p.Type is not null)
        .Select(p => Simple(p!.Type!)).FirstOrDefault(t => DiHosts.Contains(t) || RouteHosts.Contains(t));

    static void CollectDbSets(BaseTypeDeclarationSyntax td, SemanticModel model, string ctx, Proj proj, ConcurrentBag<(ISymbol?, string, string, Proj)> bag)
    {
        if (td is not TypeDeclarationSyntax t) return;
        foreach (var prop in t.Members.OfType<PropertyDeclarationSyntax>())
        {
            var g = prop.Type as GenericNameSyntax ?? (prop.Type as QualifiedNameSyntax)?.Right as GenericNameSyntax;
            if (g is null || g.Identifier.Text != "DbSet" || g.TypeArgumentList.Arguments.Count != 1) continue;
            var arg = g.TypeArgumentList.Arguments[0];
            var sym = model.GetTypeInfo(arg).Type;
            bag.Add((sym is null || sym.TypeKind == TypeKind.Error ? null : sym, Simple(arg), ctx, proj));
        }
    }

    string? FileOf(ISymbol s)
    {
        foreach (var loc in s.Locations)
            if (loc.IsInSource && loc.SourceTree is { } t && relOfFull.TryGetValue(t.FilePath, out var rel)) return rel;
        return null;
    }

    // ── pass 2 ──────────────────────────────────────────────────────────────
    Dictionary<(string, string), (int Line, int W, HashSet<string> Rel)> References(FileFacts f, SyntaxTree tree)
    {
        var model = f.Proj.Comp!.GetSemanticModel(tree);
        var outp = new Dictionary<(string, string), (int, int, HashSet<string>)>();
        int res = 0, unres = 0, amb = 0;
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            if (node is not SimpleNameSyntax name) continue;
            if (name.Parent is UsingDirectiveSyntax or BaseNamespaceDeclarationSyntax or NameColonSyntax or NameEqualsSyntax) continue;
            if (name.Ancestors().Any(a => a is UsingDirectiveSyntax or BaseNamespaceDeclarationSyntax && a.Span.Start == name.SpanStart)) continue;
            if (name.Identifier.Text == "nameof" && name.Parent is InvocationExpressionSyntax) continue;
            bool isRoot = !(name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name) && !(name.Parent is QualifiedNameSyntax qn && qn.Right == name);
            var info = model.GetSymbolInfo(name);
            ISymbol? sym = info.Symbol;
            string? target = null;
            if (sym is not null) target = Target(sym);
            else if (info.CandidateSymbols.Length > 0)
            {
                var targets = info.CandidateSymbols.Select(Target).Distinct().ToList();
                if (targets.Count == 1) { target = targets[0]; sym = info.CandidateSymbols[0]; }
                else if (info.CandidateReason == CandidateReason.Ambiguous) amb++;
            }
            if (isRoot)
            {
                if (sym is not null || info.CandidateSymbols.Length > 0) res++;
                else if (model.GetTypeInfo(name).Type is null or { TypeKind: TypeKind.Error } && !IsDeclarationName(name)) unres++;
                else res++;
            }
            if (target is null || target == f.Rel) continue;
            var line = name.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
            var rel = Relation(name, sym!);
            if (!outp.TryGetValue((f.Rel, target), out var e)) outp[(f.Rel, target)] = e = (line, 0, new HashSet<string>());
            e.Item3.Add(rel);
            outp[(f.Rel, target)] = (Math.Min(e.Item1, line), e.Item2 + 1, e.Item3);
        }
        f.Resolved = res; f.Unresolved = unres;
        Interlocked.Add(ref ambiguous, amb);
        return outp;
    }

    static bool IsDeclarationName(SimpleNameSyntax n) => n.Parent is AnonymousObjectMemberDeclaratorSyntax;

    string? Target(ISymbol s)
    {
        if (s is IAliasSymbol a) s = a.Target;
        switch (s.Kind)
        {
            case SymbolKind.Namespace or SymbolKind.Local or SymbolKind.Parameter or SymbolKind.RangeVariable or SymbolKind.Label
                or SymbolKind.Discard or SymbolKind.TypeParameter or SymbolKind.Preprocessing or SymbolKind.ErrorType:
                return null;
        }
        if (s is IMethodSymbol m)
        {
            if (m.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) return null;
            s = m.ReducedFrom ?? m;
        }
        return FileOf(s.OriginalDefinition);
    }

    static string Relation(SimpleNameSyntax name, ISymbol sym)
    {
        bool viaTypeArg = false;
        for (SyntaxNode? n = name.Parent; n is not null; n = n.Parent)
        {
            switch (n)
            {
                case TypeArgumentListSyntax: viaTypeArg = true; break;
                case BaseTypeSyntax when !viaTypeArg:
                    return sym is INamedTypeSymbol { TypeKind: TypeKind.Interface } ? "implements" : "inherits";
                case AttributeSyntax when !viaTypeArg: return "annotates";
                case AttributeArgumentListSyntax: return "uses";
                case BaseObjectCreationExpressionSyntax when !viaTypeArg: return "creates";
                case InvocationExpressionSyntax inv when inv.Expression.Span.Contains(name.Span) && sym is IMethodSymbol: return "calls";
                case StatementSyntax or MemberDeclarationSyntax or BaseListSyntax: return sym is ITypeSymbol ? "uses" : "references";
            }
        }
        return "references";
    }
}

/// Per-file code-health facts (`modules[].metrics`): functions from the syntax tree, an approximate
/// cyclomatic complexity (1 + decision points), deepest indentation, TODO markers and comment density.
/// Facts only; the smell limits are policy and live in the core.
static class Health
{
    static readonly Regex Todo = new(@"\b(TODO|FIXME|HACK|XXX)\b");

    static bool Decision(SyntaxNode n) => n switch
    {
        IfStatementSyntax or WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax or CommonForEachStatementSyntax => true,
        CaseSwitchLabelSyntax or CasePatternSwitchLabelSyntax or SwitchExpressionArmSyntax or CatchClauseSyntax => true,
        ConditionalExpressionSyntax or ConditionalAccessExpressionSyntax => true,
        BinaryExpressionSyntax b => b.Kind() is SyntaxKind.LogicalAndExpression or SyntaxKind.LogicalOrExpression or SyntaxKind.CoalesceExpression,
        AssignmentExpressionSyntax a => a.Kind() is SyntaxKind.CoalesceAssignmentExpression,
        _ => false,
    };

    static (string Name, SyntaxNode Body)? Function(SyntaxNode n) => n switch
    {
        MethodDeclarationSyntax m when m.Body is not null || m.ExpressionBody is not null => (m.Identifier.Text, m),
        ConstructorDeclarationSyntax c when c.Body is not null || c.ExpressionBody is not null => (c.Identifier.Text, c),
        DestructorDeclarationSyntax d => ("~" + d.Identifier.Text, d),
        OperatorDeclarationSyntax o => ("operator " + o.OperatorToken.Text, o),
        LocalFunctionStatementSyntax l => (l.Identifier.Text, l),
        AccessorDeclarationSyntax a when a.Body is not null || a.ExpressionBody is not null
            => ((a.Parent?.Parent as BasePropertyDeclarationSyntax) switch { PropertyDeclarationSyntax p => p.Identifier.Text, _ => "this" } + "." + a.Keyword.Text, a),
        PropertyDeclarationSyntax p when p.ExpressionBody is not null => (p.Identifier.Text, p),
        _ => null,
    };

    public static JsonObject Measure(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        var text = tree.GetText().ToString().Replace("\r\n", "\n");
        var fns = new List<(string Name, int Line, int Len, int Cc)>();
        foreach (var n in root.DescendantNodes())
        {
            if (Function(n) is not { } f) continue;
            var span = n.GetLocation().GetLineSpan();
            var cc = 1 + n.DescendantNodes().Count(Decision);
            fns.Add((f.Name, span.StartLinePosition.Line + 1, span.EndLinePosition.Line - span.StartLinePosition.Line + 1, cc));
        }
        var total = 1 + root.DescendantNodes().Count(Decision);
        var lines = text.Split('\n');
        var nest = 0;
        foreach (var l in lines)
        {
            if (l.Trim().Length == 0) continue;
            var lead = l[..(l.Length - l.TrimStart().Length)];
            var tabs = lead.Count(c => c == '\t');
            nest = Math.Max(nest, tabs + (lead.Length - tabs) / 4);
        }
        // first maximum wins
        (string Name, int Line, int Len, int Cc)? wl = null, wc = null;
        foreach (var f in fns)
        {
            if (wl is null || f.Len > wl.Value.Len) wl = f;
            if (wc is null || f.Cc > wc.Value.Cc) wc = f;
        }
        var comments = lines.Count(l => l.TrimStart().StartsWith("//"));
        return new JsonObject
        {
            ["cc"] = total,
            ["ccMax"] = wc?.Cc ?? total, ["ccFn"] = wc?.Name, ["ccLine"] = wc?.Line,
            ["fnMax"] = wl?.Len ?? 0, ["fnName"] = wl?.Name, ["fnLine"] = wl?.Line,
            ["fns"] = fns.Count, ["nest"] = nest, ["todo"] = Todo.Matches(text).Count,
            ["comments"] = Math.Round((double)comments / Math.Max(1, lines.Length), 3),
        };
    }
}
