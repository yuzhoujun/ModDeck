use crate::library::{is_ignored_sandbox_dir, is_mod_effectively_enabled, resolve_character_dir};
use crate::models::{
    CharacterHashConflict, CharacterHashConflictMod, ConflictAuditModLocation,
    ConflictAuditSummary, EnvironmentCheck, GameConflictAuditItem, GameConflictAuditReport,
    IniCommandDependency, IniHashDeclaration, IniVariableInfo, ModStaticAnalysis,
};
use regex::{Regex, RegexBuilder};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MOD_IGNORE_FILE: &str = ".moddeck-ignore";
const MAX_INI_BYTES: u64 = 2 * 1024 * 1024;

fn builtin_transient_regexes() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)(?:\\|_)(?:menu|elem|drag|seen|info|page|sub|lang|ref_w|ref_h|off_x|off_y|offset_x|offset_y|offset_x_px|offset_y_px|slider|cursor|screen|click|hover|active_elem|buttons)(?:_|\b)",
            r"(?i)\\ssmtdrag_efmi_",
            r"(?i)\\tg_gui_anim_",
            r"(?i)\\(?:tg_)?shapekey_\d+\b",
            r"(?i)\\(?:show_time|inited|finished|begin_time|delta|ui4_finished|ww|wh|mod_in_use)\b",
        ]
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
    })
}

pub fn is_transient_variable(key: &str) -> bool {
    builtin_transient_regexes().iter().any(|rx| rx.is_match(key))
}

fn normalize_var_short_name(key_or_name: &str) -> String {
    let clean = key_or_name.trim().to_ascii_lowercase();
    let tail = clean.rsplit('\\').next().unwrap_or(&clean);
    tail.trim_start_matches('$').to_string()
}

pub fn matches_ignore_rule(var_key_or_name: &str, rule: &str) -> bool {
    let raw_rule = rule.trim();
    if raw_rule.is_empty() || raw_rule.starts_with('#') || raw_rule.starts_with(';') {
        return false;
    }

    let full_key = var_key_or_name.trim().to_ascii_lowercase();
    let short_name = normalize_var_short_name(&full_key);

    if raw_rule.starts_with('/') {
        if let Some(last_slash) = raw_rule.rfind('/') {
            if last_slash > 0 {
                let body = &raw_rule[1..last_slash];
                let flags = &raw_rule[last_slash + 1..];
                let case_insensitive = true;
                let mut builder = RegexBuilder::new(body);
                builder.case_insensitive(case_insensitive || flags.contains('i'));
                if let Ok(rx) = builder.build() {
                    let dollar_short = format!("${short_name}");
                    return rx.is_match(&full_key)
                        || rx.is_match(&short_name)
                        || rx.is_match(&dollar_short);
                }
                return false;
            }
        }
    }

    let normalized_rule = raw_rule.to_ascii_lowercase();
    let normalized_rule = normalized_rule.trim_start_matches('$');
    if normalized_rule.is_empty() {
        return false;
    }

    if normalized_rule.contains('*') {
        let rx_body: String = normalized_rule
            .split('*')
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(".*");
        if let Ok(rx) = RegexBuilder::new(&format!("^{rx_body}$"))
            .case_insensitive(true)
            .build()
        {
            let stripped_full = full_key.trim_start_matches('$').trim_start_matches('\\');
            return rx.is_match(&short_name) || rx.is_match(stripped_full);
        }
        return false;
    }

    if normalized_rule.contains('\\') {
        let rule_path = normalized_rule.trim_start_matches('\\');
        let key_path = full_key.trim_start_matches('$').trim_start_matches('\\');
        return key_path == rule_path || key_path.ends_with(&format!("\\{rule_path}"));
    }

    short_name == normalized_rule
}

pub fn classify_variable_filter(
    var_key_or_name: &str,
    global_rules: &[String],
    local_rules: &[String],
) -> (bool, Option<String>) {
    if is_transient_variable(var_key_or_name) {
        return (true, Some("builtin".to_string()));
    }
    for rule in local_rules {
        if matches_ignore_rule(var_key_or_name, rule) {
            return (true, Some("local".to_string()));
        }
    }
    for rule in global_rules {
        if matches_ignore_rule(var_key_or_name, rule) {
            return (true, Some("global".to_string()));
        }
    }
    (false, None)
}

pub fn read_local_ignore_rules(mod_path: &Path) -> (bool, Vec<String>) {
    let ignore_path = mod_path.join(MOD_IGNORE_FILE);
    if !ignore_path.is_file() {
        return (false, Vec::new());
    }
    let Ok(bytes) = fs::read(&ignore_path) else {
        return (true, Vec::new());
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut seen = HashSet::new();
    let mut rules = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && !trimmed.starts_with(';')
            && seen.insert(trimmed.to_string())
        {
            rules.push(trimmed.to_string());
        }
    }
    (true, rules)
}

pub fn append_local_ignore_rule(mod_path: &Path, rule: &str) -> Result<(), String> {
    let cleaned = rule.trim();
    if cleaned.is_empty() {
        return Ok(());
    }
    let ignore_path = mod_path.join(MOD_IGNORE_FILE);
    let (exists, existing_rules) = read_local_ignore_rules(mod_path);
    if existing_rules
        .iter()
        .any(|r| r.eq_ignore_ascii_case(cleaned))
    {
        return Ok(());
    }

    let prefix = if exists {
        let cur = fs::read_to_string(&ignore_path).unwrap_or_default();
        if !cur.is_empty() && !cur.ends_with('\n') {
            format!("{cur}\r\n")
        } else {
            cur
        }
    } else {
        "# ModDeck variable ignore rules (one variable name, wildcard *, or /regex/ per line)\r\n"
            .to_string()
    };
    fs::write(&ignore_path, format!("{prefix}{cleaned}\r\n"))
        .map_err(|e| format!("Failed to write {MOD_IGNORE_FILE}: {e}"))
}

pub fn collect_mod_ini_files(mod_path: &Path, skip_disabled_dirs: bool) -> (Vec<String>, Vec<String>) {
    fn walk(
        current: &Path,
        relative: &str,
        skip_disabled_dirs: bool,
        active: &mut Vec<String>,
        disabled: &mut Vec<String>,
    ) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let full = entry.path();
            let lower = name.to_ascii_lowercase();
            if full.is_dir() {
                if skip_disabled_dirs && lower.starts_with("disabled") {
                    continue;
                }
                let next_rel = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}\\{name}")
                };
                walk(&full, &next_rel, skip_disabled_dirs, active, disabled);
                continue;
            }
            if !full.is_file() {
                continue;
            }
            if lower.ends_with(".ini") && lower != "desktop.ini" {
                let next_rel = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}\\{name}")
                };
                if lower.starts_with("disabled") {
                    disabled.push(next_rel);
                } else {
                    active.push(next_rel);
                }
            }
        }
    }

    let mut active = Vec::new();
    let mut disabled = Vec::new();
    walk(mod_path, "", skip_disabled_dirs, &mut active, &mut disabled);
    (active, disabled)
}

fn strip_ini_comment(line: &str) -> &str {
    match line.find(';') {
        Some(idx) => line[..idx].trim(),
        None => line.trim(),
    }
}

fn classify_hash_kind(section_name: &str) -> &'static str {
    let lower = section_name.to_ascii_lowercase();
    if lower.starts_with("shaderoverride")
        || lower.starts_with("shaderregex")
        || lower.starts_with("customshader")
    {
        "shader"
    } else if lower.starts_with("textureoverride") {
        "texture"
    } else {
        "other"
    }
}

fn read_ini_safe(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_INI_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn strip_disabled_prefix_ci(s: &str) -> &str {
    if s.len() >= 9 && s.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_") {
        &s[9..]
    } else {
        s
    }
}

fn extract_var_tokens(expr: &str) -> Vec<String> {
    static NS_RX: OnceLock<Regex> = OnceLock::new();
    static SIMPLE_RX: OnceLock<Regex> = OnceLock::new();
    let ns_rx = NS_RX.get_or_init(|| Regex::new(r"\$\\[^\s=!<>&|()+\-*/%,;]+").unwrap());
    let simple_rx = SIMPLE_RX.get_or_init(|| Regex::new(r"\$([a-zA-Z0-9_]+)").unwrap());

    let mut found = HashSet::new();
    for m in ns_rx.find_iter(expr) {
        found.insert(normalize_var_short_name(m.as_str()));
    }
    for cap in simple_rx.captures_iter(expr) {
        if let Some(m) = cap.get(1) {
            found.insert(m.as_str().to_ascii_lowercase());
        }
    }
    found.into_iter().collect()
}

struct ParsedSection {
    name: String,
    lower_name: String,
    runs: Vec<String>,
    cond_vars: HashSet<String>,
    write_vars: HashSet<String>,
}

struct VarDeclRecord {
    key: String,
    name: String,
    default_value: String,
    persist: bool,
    source_file: String,
}

pub fn analyze_mod_ini(mod_path: &Path, global_rules: &[String]) -> ModStaticAnalysis {
    static SECTION_RX: OnceLock<Regex> = OnceLock::new();
    static NS_DECL_RX: OnceLock<Regex> = OnceLock::new();
    static VAR_DECL_RX: OnceLock<Regex> = OnceLock::new();
    static HASH_RX: OnceLock<Regex> = OnceLock::new();
    static RUN_RX: OnceLock<Regex> = OnceLock::new();
    static COND_RX: OnceLock<Regex> = OnceLock::new();
    static WRITE_RX: OnceLock<Regex> = OnceLock::new();

    let sec_rx = SECTION_RX.get_or_init(|| Regex::new(r"^\[([^\]]+)\]").unwrap());
    let ns_rx = NS_DECL_RX.get_or_init(|| Regex::new(r"(?i)^namespace\s*=\s*(.+)$").unwrap());
    let decl_rx = VAR_DECL_RX.get_or_init(|| {
        Regex::new(r"(?i)^(global\s+persist|persist\s+global|persist|global)\s+\$([a-zA-Z0-9_]+)\s*=\s*(.+)$").unwrap()
    });
    let hash_rx = HASH_RX.get_or_init(|| Regex::new(r"(?i)^hash\s*=\s*([0-9a-f]{4,16})\b").unwrap());
    let run_rx = RUN_RX.get_or_init(|| Regex::new(r"(?i)^run\s*=\s*([a-zA-Z0-9_.\-\\]+)").unwrap());
    let cond_rx = COND_RX.get_or_init(|| Regex::new(r"(?i)^(?:else\s+)?if\s+(.+)$").unwrap());
    let write_rx = WRITE_RX.get_or_init(|| Regex::new(r"^\$(?:\\[^\s=]+|([a-zA-Z0-9_]+))\s*=").unwrap());

    let (has_local_ignore_file, local_ignore_rules) = read_local_ignore_rules(mod_path);
    let (active, disabled) = collect_mod_ini_files(mod_path, false);
    let active_set: HashSet<&str> = active.iter().map(String::as_str).collect();
    let all_inis: Vec<&str> = active
        .iter()
        .chain(disabled.iter())
        .map(String::as_str)
        .collect();

    let mut var_map: HashMap<String, VarDeclRecord> = HashMap::new();
    let mut hashes: Vec<IniHashDeclaration> = Vec::new();
    let mut sections: HashMap<String, ParsedSection> = HashMap::new();

    for rel in all_inis {
        let Some(content) = read_ini_safe(&mod_path.join(rel)) else {
            continue;
        };
        let is_active_file = active_set.contains(rel);
        let mut ns = String::new();
        let mut current_section = String::new();
        let clean_rel = rel
            .split(['\\', '/'])
            .map(strip_disabled_prefix_ci)
            .collect::<Vec<_>>()
            .join("\\");

        for raw_line in content.lines() {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
                continue;
            }

            if let Some(cap) = sec_rx.captures(trimmed) {
                current_section = cap[1].trim().to_string();
                if is_active_file {
                    let lower_sec = current_section.to_ascii_lowercase();
                    sections.entry(lower_sec.clone()).or_insert_with(|| ParsedSection {
                        name: current_section.clone(),
                        lower_name: lower_sec,
                        runs: Vec::new(),
                        cond_vars: HashSet::new(),
                        write_vars: HashSet::new(),
                    });
                }
                continue;
            }

            let line = strip_ini_comment(trimmed);
            if line.is_empty() {
                continue;
            }

            if let Some(cap) = ns_rx.captures(line) {
                ns = cap[1].trim().replace('/', "\\");
                continue;
            }

            if let Some(cap) = decl_rx.captures(line) {
                let kw = cap[1].to_ascii_lowercase();
                let is_persist = kw.contains("persist");
                let var_name = cap[2].trim().to_string();
                let default_value = cap[3].trim().to_string();
                let key = if !ns.is_empty() {
                    format!("$\\{ns}\\{var_name}")
                } else {
                    format!("$\\{clean_rel}\\{var_name}")
                }
                .to_ascii_lowercase();
                let should_insert = match var_map.get(&key) {
                    None => true,
                    Some(prev) => !prev.persist && is_persist,
                };
                if should_insert {
                    var_map.insert(
                        key.clone(),
                        VarDeclRecord {
                            key,
                            name: var_name,
                            default_value,
                            persist: is_persist,
                            source_file: rel.replace('\\', "/"),
                        },
                    );
                }
                continue;
            }

            if !is_active_file || current_section.is_empty() {
                continue;
            }
            let lower_cur = current_section.to_ascii_lowercase();

            if let Some(cap) = hash_rx.captures(line) {
                let kind = classify_hash_kind(&current_section);
                if kind != "other" {
                    hashes.push(IniHashDeclaration {
                        hash: cap[1].to_ascii_lowercase(),
                        kind: kind.to_string(),
                        section: current_section.clone(),
                        file: rel.replace('\\', "/"),
                    });
                }
                continue;
            }

            if let Some(cap) = run_rx.captures(line) {
                if let Some(sec) = sections.get_mut(&lower_cur) {
                    sec.runs.push(cap[1].trim().to_ascii_lowercase());
                }
                continue;
            }

            if let Some(cap) = cond_rx.captures(line) {
                if let Some(sec) = sections.get_mut(&lower_cur) {
                    for v in extract_var_tokens(&cap[1]) {
                        sec.cond_vars.insert(v);
                    }
                }
                continue;
            }

            if let Some(cap) = write_rx.captures(line) {
                let target = if let Some(simple) = cap.get(1) {
                    simple.as_str().to_ascii_lowercase()
                } else {
                    normalize_var_short_name(line.split('=').next().unwrap_or(""))
                };
                if !target.is_empty() {
                    if let Some(sec) = sections.get_mut(&lower_cur) {
                        sec.write_vars.insert(target);
                    }
                }
            }
        }
    }

    let mut key_driven_map: HashMap<String, HashSet<String>> = HashMap::new();
    let mut var_used_sections_map: HashMap<String, HashSet<String>> = HashMap::new();
    let mut var_written_vars_cluster: HashMap<String, HashSet<String>> = HashMap::new();
    let mut dependencies: Vec<IniCommandDependency> = Vec::new();
    let mut dep_keys: HashSet<String> = HashSet::new();
    let mut written_vars: HashSet<String> = HashSet::new();
    let mut cond_override_vars: HashSet<String> = HashSet::new();

    for sec in sections.values() {
        for v in &sec.write_vars {
            written_vars.insert(v.clone());
        }
        for v in &sec.cond_vars {
            var_used_sections_map
                .entry(v.clone())
                .or_default()
                .insert(sec.name.clone());
            if sec.lower_name.starts_with("textureoverride")
                || sec.lower_name.starts_with("shaderoverride")
                || sec.lower_name.starts_with("commandlist")
            {
                cond_override_vars.insert(v.clone());
            }
        }
    }

    let section_keys: Vec<String> = sections.keys().cloned().collect();
    for sec_key in &section_keys {
        let Some(sec) = sections.get(sec_key) else {
            continue;
        };
        let is_entry = sec.lower_name.starts_with("key")
            || sec.lower_name.starts_with("present")
            || sec.lower_name.starts_with("commandlist");
        if !is_entry {
            continue;
        }

        let mut visited: HashSet<String> = HashSet::from([sec.lower_name.clone()]);
        let mut queue: VecDeque<(String, usize)> = VecDeque::from([(sec.lower_name.clone(), 0)]);
        let mut chain_vars: HashSet<String> =
            sec.write_vars.iter().chain(sec.cond_vars.iter()).cloned().collect();

        while let Some((cur_lower, depth)) = queue.pop_front() {
            let Some(cur_sec) = sections.get(&cur_lower) else {
                continue;
            };
            for v in cur_sec.write_vars.iter().chain(cur_sec.cond_vars.iter()) {
                chain_vars.insert(v.clone());
            }
            if depth >= 6 {
                continue;
            }
            for target_lower in &cur_sec.runs {
                if let Some(target_sec) = sections.get(target_lower) {
                    let dep_id = format!("{}->{}:run", sec.name, target_sec.name);
                    if !dep_keys.contains(&dep_id) && dependencies.len() < 60 {
                        dep_keys.insert(dep_id);
                        let mut rel_vars: Vec<String> = target_sec
                            .write_vars
                            .iter()
                            .chain(target_sec.cond_vars.iter())
                            .cloned()
                            .collect::<HashSet<_>>()
                            .into_iter()
                            .collect();
                        rel_vars.sort();
                        if !rel_vars.is_empty() {
                            dependencies.push(IniCommandDependency {
                                trigger_section: sec.name.clone(),
                                target_section: target_sec.name.clone(),
                                relation: "run".to_string(),
                                variables: rel_vars,
                            });
                        }
                    }
                }
                if visited.insert(target_lower.clone()) {
                    queue.push_back((target_lower.clone(), depth + 1));
                }
            }
        }

        if sec.lower_name.starts_with("key") {
            for v in &chain_vars {
                key_driven_map
                    .entry(v.clone())
                    .or_default()
                    .insert(sec.name.clone());
            }
        }
        if chain_vars.len() > 1 {
            for v in &chain_vars {
                let entry = var_written_vars_cluster.entry(v.clone()).or_default();
                for other in &chain_vars {
                    if other != v {
                        entry.insert(other.clone());
                    }
                }
            }
        }
    }

    for sec in sections.values() {
        if !sec.cond_vars.is_empty()
            && (sec.lower_name.starts_with("textureoverride")
                || sec.lower_name.starts_with("shaderoverride"))
        {
            let mut vars_arr: Vec<String> = sec.cond_vars.iter().cloned().collect();
            vars_arr.sort();
            let dep_id = format!("cond->{}", sec.name);
            if !dep_keys.contains(&dep_id) && dependencies.len() < 60 {
                dep_keys.insert(dep_id);
                let trigger_section = vars_arr
                    .iter()
                    .map(|v| format!("${v}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                dependencies.push(IniCommandDependency {
                    trigger_section,
                    target_section: sec.name.clone(),
                    relation: "condition".to_string(),
                    variables: vars_arr,
                });
            }
        }
    }

    let mut variables = Vec::new();
    let mut non_persist_set = HashSet::new();
    let mut non_persist_control_vars = Vec::new();

    for entry in var_map.into_values() {
        let short_lower = entry.name.to_ascii_lowercase();
        let (ignored, ignore_source) =
            classify_variable_filter(&entry.key, global_rules, &local_ignore_rules);

        let mut driven_by_keys: Vec<String> = key_driven_map
            .get(&short_lower)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        driven_by_keys.sort();

        let mut used_in_sections: Vec<String> = var_used_sections_map
            .get(&short_lower)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        used_in_sections.sort();

        let mut linked_vars: Vec<String> = var_written_vars_cluster
            .get(&short_lower)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        linked_vars.sort();

        if !entry.persist
            && !ignored
            && written_vars.contains(&short_lower)
            && cond_override_vars.contains(&short_lower)
            && non_persist_set.insert(entry.name.clone())
        {
            non_persist_control_vars.push(entry.name.clone());
        }

        variables.push(IniVariableInfo {
            key: entry.key,
            name: entry.name,
            default_value: entry.default_value,
            persist: entry.persist,
            ignored,
            ignore_source,
            source_file: entry.source_file,
            driven_by_keys,
            used_in_sections,
            linked_vars,
        });
    }

    variables.sort_by(|a, b| {
        b.persist
            .cmp(&a.persist)
            .then_with(|| a.ignored.cmp(&b.ignored))
            .then_with(|| a.name.cmp(&b.name))
    });

    ModStaticAnalysis {
        variables,
        dependencies,
        hashes,
        non_persist_control_vars,
        local_ignore_rules,
        has_local_ignore_file,
    }
}

pub fn scan_character_hash_conflicts(
    mods_path: &Path,
    character_folder: &str,
) -> Result<Vec<CharacterHashConflict>, String> {
    static SECTION_RX: OnceLock<Regex> = OnceLock::new();
    static HASH_RX: OnceLock<Regex> = OnceLock::new();
    let sec_rx = SECTION_RX.get_or_init(|| Regex::new(r"^\[([^\]]+)\]").unwrap());
    let hash_rx = HASH_RX.get_or_init(|| Regex::new(r"(?i)^hash\s*=\s*([0-9a-f]{4,16})\b").unwrap());

    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let Ok(entries) = fs::read_dir(&char_dir) else {
        return Ok(Vec::new());
    };

    struct ModRecord {
        folder_name: String,
        name: String,
        sections: HashSet<String>,
        files: HashSet<String>,
        lines: HashSet<usize>,
    }
    struct HashBucket {
        kind: &'static str,
        mods: HashMap<String, ModRecord>,
    }

    let mut hash_bucket: HashMap<String, HashBucket> = HashMap::new();

    for entry in entries.flatten() {
        let mod_path = entry.path();
        let Some(dir_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !mod_path.is_dir()
            || dir_name.starts_with('.')
            || dir_name.to_ascii_lowercase().starts_with("disabled")
        {
            continue;
        }
        if !is_mod_effectively_enabled(&dir_name, &mod_path) {
            continue;
        }
        let (active, _) = collect_mod_ini_files(&mod_path, true);
        for rel in active {
            let Some(content) = read_ini_safe(&mod_path.join(&rel)) else {
                continue;
            };
            let mut current_section = String::new();
            for (idx, raw_line) in content.lines().enumerate() {
                let line_num = idx + 1;
                let trimmed = raw_line.trim();
                if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
                    continue;
                }
                if let Some(cap) = sec_rx.captures(trimmed) {
                    current_section = cap[1].trim().to_string();
                    continue;
                }
                if current_section.is_empty() {
                    continue;
                }
                let clean = strip_ini_comment(trimmed);
                let Some(cap) = hash_rx.captures(clean) else {
                    continue;
                };
                let kind = classify_hash_kind(&current_section);
                if kind == "other" {
                    continue;
                }
                let hash = cap[1].to_ascii_lowercase();
                let bucket = hash_bucket.entry(hash).or_insert_with(|| HashBucket {
                    kind,
                    mods: HashMap::new(),
                });
                let mod_rec = bucket
                    .mods
                    .entry(dir_name.clone())
                    .or_insert_with(|| ModRecord {
                        folder_name: dir_name.clone(),
                        name: strip_disabled_prefix_ci(&dir_name).to_string(),
                        sections: HashSet::new(),
                        files: HashSet::new(),
                        lines: HashSet::new(),
                    });
                mod_rec.sections.insert(current_section.clone());
                mod_rec.files.insert(rel.replace('\\', "/"));
                mod_rec.lines.insert(line_num);
            }
        }
    }

    let mut conflicts: Vec<CharacterHashConflict> = hash_bucket
        .into_iter()
        .filter(|(_, bucket)| bucket.mods.len() >= 2)
        .map(|(hash, bucket)| {
            let mut mods: Vec<CharacterHashConflictMod> = bucket
                .mods
                .into_values()
                .map(|m| {
                    let mut sections: Vec<String> = m.sections.into_iter().collect();
                    sections.sort();
                    let mut files: Vec<String> = m.files.into_iter().collect();
                    files.sort();
                    let mut lines: Vec<usize> = m.lines.into_iter().collect();
                    lines.sort_unstable();
                    CharacterHashConflictMod {
                        folder_name: m.folder_name,
                        name: m.name,
                        sections,
                        files,
                        lines: Some(lines),
                    }
                })
                .collect();
            mods.sort_by(|a, b| a.name.cmp(&b.name));
            CharacterHashConflict {
                hash,
                kind: bucket.kind.to_string(),
                severity: Some(
                    if bucket.kind == "shader" {
                        "high"
                    } else {
                        "warning"
                    }
                    .to_string(),
                ),
                mods,
            }
        })
        .collect();

    conflicts.sort_by(|a, b| a.hash.cmp(&b.hash));
    Ok(conflicts)
}

fn is_known_safe_shader_override(
    _game_id: &str,
    section_name: &str,
    filter_index: Option<&str>,
    rel_path: &str,
) -> bool {
    let lower_rel = rel_path.to_ascii_lowercase();
    let lower_sec = section_name.to_ascii_lowercase();
    let fi = filter_index.unwrap_or("").trim();

    if lower_rel.contains("rabbitfx")
        || lower_rel.contains("crossibclassifier")
        || lower_rel.contains("katfxmatcap")
    {
        return true;
    }
    if fi == "1718.1"
        || fi == "1718.2"
        || (fi.len() >= 3
            && fi.starts_with("20")
            && matches!(fi.as_bytes()[2], b'0'..=b'5')
            && (fi.len() == 3 || fi.as_bytes()[3] == b'.'))
    {
        return true;
    }
    if lower_sec.contains("rabbitfx") || lower_sec.contains("crossib") {
        return true;
    }
    false
}

fn is_likely_fx_plugin_mod(
    folder_name: &str,
    active_files: &[String],
    content_list: &[String],
) -> bool {
    let hay = format!("{} {}", folder_name, active_files.join(" ")).to_ascii_lowercase();
    if [
        "rabbitfx",
        "crossibclassifier",
        "katfxmatcap",
        "shadertweaks",
        "globalshader",
        "fxplugin",
    ]
    .iter()
    .any(|kw| hay.contains(kw))
    {
        return true;
    }
    content_list.iter().any(|c| {
        let lower = c.to_ascii_lowercase();
        lower.contains("crossibclassifier") || lower.contains("rabbitfx")
    })
}

fn has_direct_active_ini(dir_path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir_path) else {
        return false;
    };
    entries.flatten().any(|e| {
        let p = e.path();
        if !p.is_file() {
            return false;
        }
        let Some(name) = e.file_name().to_str().map(|s| s.to_ascii_lowercase()) else {
            return false;
        };
        name.ends_with(".ini") && name != "desktop.ini" && !name.starts_with("disabled")
    })
}

fn severity_weight(s: &str) -> u8 {
    match s {
        "high" => 3,
        "warning" => 2,
        _ => 1,
    }
}

fn dedupe_locs_by_mod(locs: &[ConflictAuditModLocation]) -> Vec<ConflictAuditModLocation> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for l in locs {
        let key = format!("{}/{}", l.character_folder, l.folder_name);
        if seen.insert(key) {
            out.push(l.clone());
        }
    }
    out
}

fn normalize_ini_key_binding(raw: &str) -> Option<String> {
    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for raw_tok in raw.split_whitespace() {
        let tok = raw_tok.trim_matches('+').to_ascii_lowercase();
        if tok.is_empty()
            || matches!(
                tok.as_str(),
                "no_ctrl" | "no_alt" | "no_shift" | "no_modifiers" | "no_win"
            )
        {
            continue;
        }
        match tok.as_str() {
            "ctrl" | "control" | "lctrl" | "rctrl" | "vk_control" | "vk_lcontrol" | "vk_rcontrol" => {
                if !modifiers.contains(&"ctrl") {
                    modifiers.push("ctrl");
                }
            }
            "alt" | "menu" | "lalt" | "ralt" | "vk_menu" | "vk_lmenu" | "vk_rmenu" => {
                if !modifiers.contains(&"alt") {
                    modifiers.push("alt");
                }
            }
            "shift" | "lshift" | "rshift" | "vk_shift" | "vk_lshift" | "vk_rshift" => {
                if !modifiers.contains(&"shift") {
                    modifiers.push("shift");
                }
            }
            "win" | "lwin" | "rwin" | "vk_lwin" | "vk_rwin" => {
                if !modifiers.contains(&"win") {
                    modifiers.push("win");
                }
            }
            _ => keys.push(tok),
        }
    }
    if keys.is_empty() {
        return None;
    }
    let mut ordered = Vec::new();
    for m in ["ctrl", "alt", "shift", "win"] {
        if modifiers.contains(&m) {
            ordered.push(m.to_string());
        }
    }
    ordered.extend(keys);
    Some(ordered.join("+"))
}

pub fn audit_game_mods_conflicts(
    game_id: &str,
    mods_path: &str,
    environment: Option<EnvironmentCheck>,
    ignored_mod_dirs: &[String],
    is_en: bool,
) -> GameConflictAuditReport {
    static SECTION_RX: OnceLock<Regex> = OnceLock::new();
    static FI_RX: OnceLock<Regex> = OnceLock::new();
    static SKIP_RX: OnceLock<Regex> = OnceLock::new();
    static HASH_RX: OnceLock<Regex> = OnceLock::new();
    static KEY_RX: OnceLock<Regex> = OnceLock::new();
    static COND_RX: OnceLock<Regex> = OnceLock::new();
    let sec_rx = SECTION_RX.get_or_init(|| Regex::new(r"^\[([^\]]+)\]").unwrap());
    let fi_rx = FI_RX.get_or_init(|| Regex::new(r"(?i)^filter_index\s*=\s*(.+)$").unwrap());
    let skip_rx = SKIP_RX.get_or_init(|| Regex::new(r"(?i)^handling\s*=\s*skip\b").unwrap());
    let hash_rx = HASH_RX.get_or_init(|| Regex::new(r"(?i)^hash\s*=\s*([0-9a-f]{4,16})\b").unwrap());
    let key_rx = KEY_RX.get_or_init(|| Regex::new(r"(?i)^key\s*=\s*(.+)$").unwrap());
    let cond_rx = COND_RX.get_or_init(|| Regex::new(r"(?i)^condition\s*=\s*(.+)$").unwrap());

    let mut items: Vec<GameConflictAuditItem> = Vec::new();
    let mut scanned_mods = 0usize;
    let mut scanned_ini_files = 0usize;

    if let Some(env) = &environment {
        if let Some(sf) = &env.shader_fixes {
            if sf.dir_exists && sf.file_count > 0 {
                let samples = sf.sample_files.join(", ");
                items.push(GameConflictAuditItem {
                    id: "env:shader-fixes".to_string(),
                    severity: "warning".to_string(),
                    category: "shader-fixes".to_string(),
                    message: if is_en {
                        format!("ShaderFixes directory contains {} custom shader files", sf.file_count)
                    } else {
                        format!("ShaderFixes 目录存有 {} 个自定义着色器文件", sf.file_count)
                    },
                    detail: Some(if is_en {
                        format!("Custom shader files ({samples}, etc.) found in ShaderFixes; leftover de-blur or outline patches may cause mesh/shadow glitches.")
                    } else {
                        format!("目录内存在 {samples} 等着色器补丁文件，旧版去模糊或轮廓光残留补丁可能导致模型破面或鬼影。")
                    }),
                    hash: None,
                    filter_index: None,
                    locations: Vec::new(),
                });
            }
        }
        if let Some(sc) = &env.shader_cache {
            if sc.dir_exists && sc.file_count > 0 {
                let detail = if sc.enabled_in_ini == Some(true) {
                    if is_en {
                        "d3dx.ini has cache_shaders = 1 enabled; clear ShaderCache if artifacts persist after disabling mods."
                    } else {
                        "d3dx.ini 已开启 cache_shaders = 1；若禁用冲突 Mod 后仍有残留异常，建议清空 ShaderCache。"
                    }
                } else if is_en {
                    "Cached shader files are present; clear them if visual artifacts persist."
                } else {
                    "当前目录存有着色器缓存文件；排查花屏或残影问题时可点击清空。"
                };
                items.push(GameConflictAuditItem {
                    id: "env:shader-cache".to_string(),
                    severity: "info".to_string(),
                    category: "shader-cache".to_string(),
                    message: if is_en {
                        format!("ShaderCache directory contains {} cached files", sc.file_count)
                    } else {
                        format!("ShaderCache 目录存在 {} 个缓存文件", sc.file_count)
                    },
                    detail: Some(detail.to_string()),
                    hash: None,
                    filter_index: None,
                    locations: Vec::new(),
                });
            }
        }
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mods_root = Path::new(mods_path);
    if mods_path.trim().is_empty() || !mods_root.is_dir() {
        return GameConflictAuditReport {
            game_id: game_id.to_string(),
            mods_path: mods_path.to_string(),
            scanned_at: now_ms,
            scanned_mods,
            scanned_ini_files,
            environment,
            summary: ConflictAuditSummary {
                high: items.iter().filter(|i| i.severity == "high").count(),
                warning: items.iter().filter(|i| i.severity == "warning").count(),
                info: items.iter().filter(|i| i.severity == "info").count(),
            },
            items,
        };
    }

    struct ModScanUnit {
        character_folder: String,
        folder_name: String,
        name: String,
        mod_path: std::path::PathBuf,
    }
    let mut mod_units: Vec<ModScanUnit> = Vec::new();
    if let Ok(top_entries) = fs::read_dir(mods_root) {
        for top in top_entries.flatten() {
            let top_path = top.path();
            let Some(top_name) = top.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !top_path.is_dir()
                || is_ignored_sandbox_dir(&top_name, ignored_mod_dirs)
                || top_name.to_ascii_lowercase().starts_with("disabled")
            {
                continue;
            }
            if has_direct_active_ini(&top_path) {
                mod_units.push(ModScanUnit {
                    character_folder: String::new(),
                    name: strip_disabled_prefix_ci(&top_name).to_string(),
                    folder_name: top_name,
                    mod_path: top_path,
                });
                continue;
            }
            let mut pushed_sub = false;
            if let Ok(sub_entries) = fs::read_dir(&top_path) {
                for sub in sub_entries.flatten() {
                    let sub_path = sub.path();
                    let Some(sub_name) = sub.file_name().to_str().map(str::to_string) else {
                        continue;
                    };
                    let sub_ignored = sub_name.eq_ignore_ascii_case("efmi-mcp")
                        || ignored_mod_dirs
                            .iter()
                            .any(|x| x.trim().eq_ignore_ascii_case(&sub_name));
                    if !sub_path.is_dir()
                        || sub_name.starts_with('.')
                        || sub_ignored
                        || sub_name.to_ascii_lowercase().starts_with("disabled")
                    {
                        continue;
                    }
                    if !is_mod_effectively_enabled(&sub_name, &sub_path) {
                        continue;
                    }
                    mod_units.push(ModScanUnit {
                        character_folder: top_name.clone(),
                        name: strip_disabled_prefix_ci(&sub_name).to_string(),
                        folder_name: sub_name,
                        mod_path: sub_path,
                    });
                    pushed_sub = true;
                }
            }
            if !pushed_sub {
                let (active, _) = collect_mod_ini_files(&top_path, true);
                if !active.is_empty() {
                    mod_units.push(ModScanUnit {
                        character_folder: String::new(),
                        name: strip_disabled_prefix_ci(&top_name).to_string(),
                        folder_name: top_name,
                        mod_path: top_path,
                    });
                }
            }
        }
    }

    struct ParsedConflictSection {
        section: String,
        lower_section: String,
        start_line: usize,
        file: String,
        hashes: Vec<(String, usize)>,
        filter_index: Option<String>,
        has_handling_skip: bool,
        key_bindings: Vec<(String, String, usize)>,
        has_condition_guard: bool,
    }

    let mut rabbit_fx_locs: Vec<ConflictAuditModLocation> = Vec::new();
    let mut cross_ib_locs: Vec<ConflictAuditModLocation> = Vec::new();
    let mut kat_fx_locs: Vec<ConflictAuditModLocation> = Vec::new();
    let mut char_hash_map: HashMap<String, HashMap<String, (&'static str, Vec<ConflictAuditModLocation>)>> =
        HashMap::new();
    let mut global_so_map: HashMap<String, Vec<ConflictAuditModLocation>> = HashMap::new();
    let mut hotkey_map: HashMap<String, Vec<(String, bool, ConflictAuditModLocation)>> =
        HashMap::new();

    for unit in mod_units {
        scanned_mods += 1;
        let (active, _) = collect_mod_ini_files(&unit.mod_path, true);
        let mut active_texts = Vec::new();
        let mut sections_parsed: Vec<ParsedConflictSection> = Vec::new();

        for rel in &active {
            scanned_ini_files += 1;
            let Some(content) = read_ini_safe(&unit.mod_path.join(rel)) else {
                continue;
            };
            active_texts.push(content.clone());

            let rel_posix = rel.replace('\\', "/");
            let base_ini = Path::new(rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let lower_rel = rel_posix.to_ascii_lowercase();
            let lower_folder = unit.folder_name.to_ascii_lowercase();

            if base_ini == "rabbitfx.ini" || (lower_folder.contains("rabbitfx") && lower_rel == base_ini)
            {
                rabbit_fx_locs.push(ConflictAuditModLocation {
                    character_folder: unit.character_folder.clone(),
                    folder_name: unit.folder_name.clone(),
                    name: unit.name.clone(),
                    file: rel_posix.clone(),
                    line: 1,
                    section: None,
                    snippet: None,
                });
            }
            if base_ini == "crossibclassifier.ini" {
                cross_ib_locs.push(ConflictAuditModLocation {
                    character_folder: unit.character_folder.clone(),
                    folder_name: unit.folder_name.clone(),
                    name: unit.name.clone(),
                    file: rel_posix.clone(),
                    line: 1,
                    section: None,
                    snippet: None,
                });
            }
            if base_ini.contains("katfxmatcap") || lower_folder.contains("katfxmatcap") {
                kat_fx_locs.push(ConflictAuditModLocation {
                    character_folder: unit.character_folder.clone(),
                    folder_name: unit.folder_name.clone(),
                    name: unit.name.clone(),
                    file: rel_posix.clone(),
                    line: 1,
                    section: None,
                    snippet: None,
                });
            }

            let mut current: Option<ParsedConflictSection> = None;
            for (idx, raw_line) in content.lines().enumerate() {
                let line_num = idx + 1;
                let trimmed = raw_line.trim();
                if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
                    continue;
                }
                if let Some(cap) = sec_rx.captures(trimmed) {
                    if let Some(prev) = current.take() {
                        sections_parsed.push(prev);
                    }
                    let sec_name = cap[1].trim().to_string();
                    current = Some(ParsedConflictSection {
                        lower_section: sec_name.to_ascii_lowercase(),
                        section: sec_name,
                        start_line: line_num,
                        file: rel_posix.clone(),
                        hashes: Vec::new(),
                        filter_index: None,
                        has_handling_skip: false,
                        key_bindings: Vec::new(),
                        has_condition_guard: false,
                    });
                    continue;
                }
                let Some(cur) = current.as_mut() else {
                    continue;
                };
                let clean = strip_ini_comment(trimmed);
                if clean.is_empty() {
                    continue;
                }
                if cur.lower_section.starts_with("key") {
                    if let Some(cap) = cond_rx.captures(clean) {
                        let rhs = cap[1].trim();
                        if !rhs.is_empty() && rhs != "1" && !rhs.eq_ignore_ascii_case("true") {
                            cur.has_condition_guard = true;
                        }
                    }
                    if let Some(cap) = key_rx.captures(clean) {
                        let raw_key = cap[1].trim().to_string();
                        if let Some(norm_key) = normalize_ini_key_binding(&raw_key) {
                            cur.key_bindings.push((norm_key, raw_key, line_num));
                        }
                    }
                }
                if let Some(cap) = fi_rx.captures(clean) {
                    cur.filter_index = Some(cap[1].trim().to_string());
                }
                if skip_rx.is_match(clean) {
                    cur.has_handling_skip = true;
                }
                if let Some(cap) = hash_rx.captures(clean) {
                    let hash = cap[1].to_ascii_lowercase();
                    let kind = classify_hash_kind(&cur.section);
                    cur.hashes.push((hash.clone(), line_num));
                    if !unit.character_folder.is_empty() && kind != "other" {
                        let by_hash = char_hash_map.entry(unit.character_folder.clone()).or_default();
                        let entry = by_hash.entry(hash).or_insert((kind, Vec::new()));
                        entry.1.push(ConflictAuditModLocation {
                            character_folder: unit.character_folder.clone(),
                            folder_name: unit.folder_name.clone(),
                            name: unit.name.clone(),
                            file: rel_posix.clone(),
                            line: line_num,
                            section: Some(cur.section.clone()),
                            snippet: None,
                        });
                    }
                }
            }
            if let Some(prev) = current.take() {
                sections_parsed.push(prev);
            }
        }

        let is_plugin = is_likely_fx_plugin_mod(&unit.folder_name, &active, &active_texts);
        for sec in sections_parsed {
            for (norm_key, raw_key, line_num) in &sec.key_bindings {
                hotkey_map.entry(norm_key.clone()).or_default().push((
                    raw_key.clone(),
                    sec.has_condition_guard,
                    ConflictAuditModLocation {
                        character_folder: unit.character_folder.clone(),
                        folder_name: unit.folder_name.clone(),
                        name: unit.name.clone(),
                        file: sec.file.clone(),
                        line: *line_num,
                        section: Some(sec.section.clone()),
                        snippet: Some(format!("key = {raw_key}")),
                    },
                ));
            }
            if sec.lower_section.starts_with("shaderregex") && !is_plugin {
                items.push(GameConflictAuditItem {
                    id: format!(
                        "regex:{}/{}:{}:{}",
                        unit.character_folder, unit.folder_name, sec.file, sec.start_line
                    ),
                    severity: "warning".to_string(),
                    category: "embedded-shader-regex".to_string(),
                    message: if is_en {
                        format!("{} embeds [{}]", unit.name, sec.section)
                    } else {
                        format!("{} 内嵌了 [{}]", unit.name, sec.section)
                    },
                    detail: Some(if is_en {
                        "A character/outfit mod declares an inline [ShaderRegex] section, which often clashes with shared shader classifiers or other mods.".to_string()
                    } else {
                        "非前置插件的普通/角色 Mod 内嵌了 [ShaderRegex] 段，容易与公共着色器分类器或其它 Mod 冲突。".to_string()
                    }),
                    hash: None,
                    filter_index: None,
                    locations: vec![ConflictAuditModLocation {
                        character_folder: unit.character_folder.clone(),
                        folder_name: unit.folder_name.clone(),
                        name: unit.name.clone(),
                        file: sec.file.clone(),
                        line: sec.start_line,
                        section: Some(sec.section.clone()),
                        snippet: None,
                    }],
                });
            }

            if sec.lower_section.starts_with("shaderoverride") {
                let safe = is_known_safe_shader_override(
                    game_id,
                    &sec.section,
                    sec.filter_index.as_deref(),
                    &sec.file,
                );
                for (hash, line_num) in &sec.hashes {
                    let loc = ConflictAuditModLocation {
                        character_folder: unit.character_folder.clone(),
                        folder_name: unit.folder_name.clone(),
                        name: unit.name.clone(),
                        file: sec.file.clone(),
                        line: *line_num,
                        section: Some(sec.section.clone()),
                        snippet: None,
                    };
                    global_so_map.entry(hash.clone()).or_default().push(loc.clone());

                    if !safe && sec.has_handling_skip {
                        items.push(GameConflictAuditItem {
                            id: format!("so-skip:{}:{}:{}", unit.folder_name, sec.file, line_num),
                            severity: "warning".to_string(),
                            category: "shader-override".to_string(),
                            message: if is_en {
                                format!("{} declares raw global ShaderOverride ({})", unit.name, hash)
                            } else {
                                format!("{} 包含裸全局 ShaderOverride（{}）", unit.name, hash)
                            },
                            detail: Some(if is_en {
                                format!("[{}] uses handling = skip without a known safe filter_index channel and may affect global rendering.", sec.section)
                            } else {
                                format!("[{}] 未使用常规安全通道标记且包含 handling = skip，可能误伤游戏全局画面或与其它 Mod 冲突。", sec.section)
                            }),
                            hash: Some(hash.clone()),
                            filter_index: sec.filter_index.clone(),
                            locations: vec![loc],
                        });
                    }
                }
            }
        }
    }

    let rabbit_mods = dedupe_locs_by_mod(&rabbit_fx_locs);
    if rabbit_mods.len() > 1 {
        items.push(GameConflictAuditItem {
            id: "dup:rabbitfx".to_string(),
            severity: "high".to_string(),
            category: "duplicate-fx-plugin".to_string(),
            message: if is_en {
                format!("Duplicate shared FX plugin detected: RabbitFX ({} copies)", rabbit_mods.len())
            } else {
                format!("检测到重复的共享前置插件：RabbitFX（共 {} 份）", rabbit_mods.len())
            },
            detail: Some(if is_en {
                "Multiple active copies of the same shared FX plugin exist in this Mods directory, which may cause duplicate hooks or rendering glitches.".to_string()
            } else {
                "同一游戏 Mods 目录下存在多个相同的共享前置插件副本，可能引发重复注入或渲染崩溃。".to_string()
            }),
            hash: None,
            filter_index: None,
            locations: rabbit_mods.clone(),
        });
    }

    let cross_ib_mods = dedupe_locs_by_mod(&cross_ib_locs);
    if cross_ib_mods.len() > 1 {
        items.push(GameConflictAuditItem {
            id: "dup:crossib".to_string(),
            severity: "high".to_string(),
            category: "duplicate-fx-plugin".to_string(),
            message: if is_en {
                format!("Duplicate shared FX plugin detected: CrossIBClassifier.ini ({} copies)", cross_ib_mods.len())
            } else {
                format!("检测到重复的共享前置插件：CrossIBClassifier.ini（共 {} 份）", cross_ib_mods.len())
            },
            detail: Some(if is_en {
                "Multiple active copies of the same shared FX plugin exist in this Mods directory, which may cause duplicate hooks or rendering glitches.".to_string()
            } else {
                "同一游戏 Mods 目录下存在多个相同的共享前置插件副本，可能引发重复注入或渲染崩溃。".to_string()
            }),
            hash: None,
            filter_index: None,
            locations: cross_ib_mods,
        });
    }

    let kat_mods = dedupe_locs_by_mod(&kat_fx_locs);
    if !rabbit_mods.is_empty() && !kat_mods.is_empty() {
        let mut combined = rabbit_mods;
        combined.extend(kat_mods);
        items.push(GameConflictAuditItem {
            id: "mutex:rabbitfx-katfx".to_string(),
            severity: "high".to_string(),
            category: "mutually-exclusive-fx".to_string(),
            message: if is_en {
                "Mutually exclusive FX plugins enabled: KatFXMatcap and RabbitFX".to_string()
            } else {
                "检测到互斥的 FX 前置插件并存：KatFXMatcap 与 RabbitFX".to_string()
            },
            detail: Some(if is_en {
                "KatFXMatcap and RabbitFX are enabled simultaneously; their shader pipelines conflict with each other.".to_string()
            } else {
                "同时启用了 KatFXMatcap 与 RabbitFX，两者材质/着色器链路互斥，易产生异常效果。".to_string()
            }),
            hash: None,
            filter_index: None,
            locations: combined,
        });
    }

    for (hash, locs) in global_so_map {
        let distinct = dedupe_locs_by_mod(&locs);
        if distinct.len() < 2 {
            continue;
        }
        items.push(GameConflictAuditItem {
            id: format!("global-so:{hash}"),
            severity: "high".to_string(),
            category: "shader-override".to_string(),
            message: if is_en {
                format!("Global ShaderOverride hash collision: {hash} ({} mods)", distinct.len())
            } else {
                format!("全局 ShaderOverride Hash 碰撞：{hash}（涉及 {} 个 Mod）", distinct.len())
            },
            detail: Some(if is_en {
                "Multiple enabled mods target the same [ShaderOverride] hash, likely causing shader hijacking or broken rendering.".to_string()
            } else {
                "多个已启用 Mod 声明了相同的 [ShaderOverride] Hash，极易造成模型/着色器抢占或花屏。".to_string()
            }),
            hash: Some(hash),
            filter_index: None,
            locations: locs,
        });
    }

    for (char_folder, hash_map) in char_hash_map {
        for (hash, (kind, locs)) in hash_map {
            let distinct = dedupe_locs_by_mod(&locs);
            if distinct.len() < 2 {
                continue;
            }
            let severity = if kind == "shader" { "high" } else { "warning" };
            items.push(GameConflictAuditItem {
                id: format!("char-hash:{char_folder}:{hash}"),
                severity: severity.to_string(),
                category: "hash-collision".to_string(),
                message: if is_en {
                    format!("Hash collision in {char_folder}: {hash} ({} mods)", distinct.len())
                } else {
                    format!("角色「{char_folder}」存在 Hash 重叠：{hash}（涉及 {} 个 Mod）", distinct.len())
                },
                detail: Some(if is_en {
                    format!("Multiple enabled mods for this character declare the same {kind} hash, which may cause visual artifacts or overlap.")
                } else {
                    format!("同一角色下多个已启用 Mod 声明了相同的 {kind} Hash，可能导致渲染异常或互相覆盖。")
                }),
                hash: Some(hash),
                filter_index: None,
                locations: locs,
            });
        }
    }

    for (norm_key, entries) in hotkey_map {
        let mut by_char: HashMap<String, Vec<(String, bool, ConflictAuditModLocation)>> =
            HashMap::new();
        for (display, guarded, loc) in &entries {
            if !loc.character_folder.is_empty() {
                by_char
                    .entry(loc.character_folder.clone())
                    .or_default()
                    .push((display.clone(), *guarded, loc.clone()));
            }
        }
        let mut single_char_covered: Vec<String> = Vec::new();
        for (char_folder, char_entries) in &by_char {
            let char_locs: Vec<ConflictAuditModLocation> =
                char_entries.iter().map(|(_, _, l)| l.clone()).collect();
            let distinct = dedupe_locs_by_mod(&char_locs);
            if distinct.len() >= 2 {
                single_char_covered.push(char_folder.clone());
                let display_key = char_entries
                    .first()
                    .map(|(d, _, _)| d.as_str())
                    .unwrap_or(norm_key.as_str());
                items.push(GameConflictAuditItem {
                    id: format!("hotkey:char:{char_folder}:{norm_key}"),
                    severity: "warning".to_string(),
                    category: "hotkey-collision".to_string(),
                    message: if is_en {
                        format!(
                            "Hotkey collision in {char_folder}: {display_key} ({} mods)",
                            distinct.len()
                        )
                    } else {
                        format!(
                            "角色「{char_folder}」快捷键冲突：{display_key}（涉及 {} 个 Mod）",
                            distinct.len()
                        )
                    },
                    detail: Some(if is_en {
                        "Multiple enabled mods for this character bind the same key; pressing it will trigger both mods simultaneously.".to_string()
                    } else {
                        "同一角色下多个已启用 Mod 绑定了相同按键，游戏内按下该按键将同时触发多个 Mod 的切换。".to_string()
                    }),
                    hash: None,
                    filter_index: None,
                    locations: dedupe_locs_by_mod(&char_locs),
                });
            }
        }

        let all_locs: Vec<ConflictAuditModLocation> =
            entries.iter().map(|(_, _, l)| l.clone()).collect();
        let all_distinct = dedupe_locs_by_mod(&all_locs);
        if all_distinct.len() >= 2 {
            let distinct_chars: HashSet<&str> = entries
                .iter()
                .filter(|(_, _, l)| !l.character_folder.is_empty())
                .map(|(_, _, l)| l.character_folder.as_str())
                .collect();
            let has_root_mod = entries.iter().any(|(_, _, l)| l.character_folder.is_empty());
            if distinct_chars.len() > 1 || has_root_mod {
                let any_unguarded = entries.iter().any(|(_, guarded, _)| !*guarded);
                let display_key = entries
                    .first()
                    .map(|(d, _, _)| d.as_str())
                    .unwrap_or(norm_key.as_str());
                if any_unguarded {
                    items.push(GameConflictAuditItem {
                        id: format!("hotkey:global-unguarded:{norm_key}"),
                        severity: "warning".to_string(),
                        category: "hotkey-collision".to_string(),
                        message: if is_en {
                            format!(
                                "Unguarded global hotkey collision: {display_key} ({} mods)",
                                all_distinct.len()
                            )
                        } else {
                            format!(
                                "全局无门控快捷键冲突：{display_key}（涉及 {} 个 Mod）",
                                all_distinct.len()
                            )
                        },
                        detail: Some(if is_en {
                            "Multiple mods across characters or root folders bind this hotkey without a condition/$active guard, so pressing it may toggle unrelated mods.".to_string()
                        } else {
                            "多个跨角色或全局 Mod 绑定了相同按键且缺少 condition / $active 条件门控，按下时可能误触其它角色的变体开关。".to_string()
                        }),
                        hash: None,
                        filter_index: None,
                        locations: all_distinct,
                    });
                } else {
                    items.push(GameConflictAuditItem {
                        id: format!("hotkey:cross-char:{norm_key}"),
                        severity: "info".to_string(),
                        category: "hotkey-collision".to_string(),
                        message: if is_en {
                            format!(
                                "Cross-character guarded hotkey reuse: {display_key} ({} mods)",
                                all_distinct.len()
                            )
                        } else {
                            format!(
                                "跨角色条件门控热键复用：{display_key}（涉及 {} 个 Mod）",
                                all_distinct.len()
                            )
                        },
                        detail: Some(if is_en {
                            "All bindings declare condition/$active guards across different characters; usually harmless unless multiple affected characters are active on screen together.".to_string()
                        } else {
                            "相关快捷键均带有 condition / $active 条件门控，仅当对应多名角色同场渲染时才可能互串；一般无需处理。".to_string()
                        }),
                        hash: None,
                        filter_index: None,
                        locations: all_distinct,
                    });
                }
            }
        }
    }

    items.sort_by(|a, b| {
        severity_weight(&b.severity)
            .cmp(&severity_weight(&a.severity))
            .then_with(|| a.id.cmp(&b.id))
    });

    GameConflictAuditReport {
        game_id: game_id.to_string(),
        mods_path: mods_path.to_string(),
        scanned_at: now_ms,
        scanned_mods,
        scanned_ini_files,
        environment,
        summary: ConflictAuditSummary {
            high: items.iter().filter(|i| i.severity == "high").count(),
            warning: items.iter().filter(|i| i.severity == "warning").count(),
            info: items.iter().filter(|i| i.severity == "info").count(),
        },
        items,
    }
}

pub fn format_conflict_audit_report_text(
    game_name: &str,
    report: &GameConflictAuditReport,
    is_en: bool,
) -> String {
    let mut lines = Vec::new();
    lines.push("============================================================".to_string());
    lines.push(format!("ModDeck Conflict Audit Report - {game_name} ({})", report.game_id));
    lines.push(format!("Generated At : {}", crate::storage::format_timestamp_dir_utc()));
    lines.push(format!(
        "Mods Path    : {}",
        if report.mods_path.is_empty() { "-" } else { &report.mods_path }
    ));
    lines.push(format!(
        "Scanned      : {} enabled mod(s), {} .ini file(s)",
        report.scanned_mods, report.scanned_ini_files
    ));
    lines.push(format!(
        "Summary      : HIGH={}, WARNING={}, INFO={}",
        report.summary.high, report.summary.warning, report.summary.info
    ));
    if let Some(env) = &report.environment {
        lines.push(format!(
            "d3dx.ini     : {} ({})",
            env.status,
            if env.d3dx_path.is_empty() { "-" } else { &env.d3dx_path }
        ));
        if let Some(sc) = &env.shader_cache {
            let cs = match sc.enabled_in_ini {
                None => "unset",
                Some(true) => "1",
                Some(false) => "0",
            };
            lines.push(format!(
                "ShaderCache  : cache_shaders={cs}, files={}",
                sc.file_count
            ));
        }
        if let Some(sf) = &env.shader_fixes {
            lines.push(format!("ShaderFixes  : files={}", sf.file_count));
        }
    }
    lines.push("============================================================".to_string());
    lines.push(String::new());

    if report.items.is_empty() {
        lines.push(
            if is_en {
                "No obvious conflicts or environment warnings found"
            } else {
                "未发现明显冲突或环境风险"
            }
            .to_string(),
        );
        return lines.join("\r\n");
    }

    for (idx, item) in report.items.iter().enumerate() {
        lines.push(format!(
            "{}. [{}] [{}] {}",
            idx + 1,
            item.severity.to_ascii_uppercase(),
            item.category,
            item.message
        ));
        if let Some(detail) = &item.detail {
            lines.push(format!("   Detail: {detail}"));
        }
        for loc in &item.locations {
            let char_part = if loc.character_folder.is_empty() {
                String::new()
            } else {
                format!("{}/", loc.character_folder)
            };
            let sec_part = loc
                .section
                .as_deref()
                .map(|s| format!(" [{s}]"))
                .unwrap_or_default();
            lines.push(format!(
                "   - {}{} -> {}:{} {}",
                char_part, loc.folder_name, loc.file, loc.line, sec_part
            ));
        }
        lines.push(String::new());
    }
    lines.join("\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_ini_variables_dependencies_and_ignore_rules() {
        let root = std::env::temp_dir().join(format!("moddeck-ini-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mod_dir = root.join("Anke").join("TestMod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(
            mod_dir.join("mod.ini"),
            concat!(
                "namespace = Anke\\TestMod\r\n",
                "[Constants]\r\n",
                "global persist $variant = 0\r\n",
                "global $mode = 1\r\n",
                "global persist $drag_x = 0\r\n",
                "[KeyToggle]\r\n",
                "key = K\r\n",
                "run = CommandListSwitch\r\n",
                "[CommandListSwitch]\r\n",
                "$mode = 2\r\n",
                "[TextureOverrideBody]\r\n",
                "hash = 1234abcd\r\n",
                "if $mode == 2\r\n",
                "endif\r\n",
            ),
        )
        .unwrap();

        let analysis = analyze_mod_ini(&mod_dir, &[]);
        assert_eq!(analysis.variables.len(), 3);
        assert!(analysis.non_persist_control_vars.contains(&"mode".to_string()));
        let drag = analysis.variables.iter().find(|v| v.name == "drag_x").unwrap();
        assert!(drag.ignored);
        assert_eq!(drag.ignore_source.as_deref(), Some("builtin"));
        assert!(!analysis.dependencies.is_empty());

        append_local_ignore_rule(&mod_dir, "mode*").unwrap();
        let analysis2 = analyze_mod_ini(&mod_dir, &[]);
        let mode_var = analysis2.variables.iter().find(|v| v.name == "mode").unwrap();
        assert!(mode_var.ignored);
        assert_eq!(mode_var.ignore_source.as_deref(), Some("local"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_character_and_global_conflicts() {
        let root = std::env::temp_dir().join(format!("moddeck-audit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mods_dir = root.join("Mods");
        let mod_a = mods_dir.join("Anke").join("ModA");
        let mod_b = mods_dir.join("Anke").join("ModB");
        let sandbox_mcp = mods_dir.join("EFMI-MCP").join("Dummy");
        let bridge_dir = mods_dir.join("_ModDeck_Preset_Bridge");
        fs::create_dir_all(&mod_a).unwrap();
        fs::create_dir_all(&mod_b).unwrap();
        fs::create_dir_all(&sandbox_mcp).unwrap();
        fs::create_dir_all(&bridge_dir).unwrap();
        fs::write(
            sandbox_mcp.join("mcp.ini"),
            "[TextureOverrideBody]\nhash = deadbeef\n[ShaderOverrideGlow]\nhash = 99998888\nfilter_index = 2\n",
        )
        .unwrap();
        fs::write(
            bridge_dir.join("bridge.ini"),
            "[TextureOverrideBody]\nhash = deadbeef\nfilter_index = 9\n",
        )
        .unwrap();

        fs::write(
            mod_a.join("a.ini"),
            "[TextureOverrideBody]\nhash = deadbeef\n[ShaderOverrideGlow]\nhash = 11223344\nhandling = skip\n",
        )
        .unwrap();
        fs::write(
            mod_b.join("b.ini"),
            "[TextureOverrideBody]\nhash = deadbeef\n[ShaderOverrideGlow]\nhash = 11223344\n",
        )
        .unwrap();

        let char_conflicts = scan_character_hash_conflicts(&mods_dir, "Anke").unwrap();
        assert_eq!(char_conflicts.len(), 2);

        let report =
            audit_game_mods_conflicts("wuthering-waves", &mods_dir.to_string_lossy(), None, &[], true);
        assert!(report.summary.high >= 1);
        assert!(report.summary.warning >= 2);
        assert_eq!(report.scanned_mods, 2);
        let txt = format_conflict_audit_report_text("Wuthering Waves", &report, true);
        assert!(txt.contains("deadbeef"));
        assert!(!txt.contains("EFMI-MCP"));
        assert!(!txt.contains("bridge.ini"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_tiered_hotkey_collisions() {
        let root = std::env::temp_dir().join(format!("moddeck-hotkey-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mods_dir = root.join("Mods");

        // (a) Same-character collision: Mod1 & Mod2 under Anke both bind K -> warning
        let anke_1 = mods_dir.join("Anke").join("Mod1");
        let anke_2 = mods_dir.join("Anke").join("Mod2");
        // (b) Cross-character unguarded collision: Jinhsi & Changli both bind unguarded Ctrl+G -> warning
        let jinhsi_u = mods_dir.join("Jinhsi").join("DressA");
        let changli_u = mods_dir.join("Changli").join("DressB");
        // (c) Cross-character condition-guarded reuse: Sanhua & Verina both bind Alt+H with $active == 1 -> info
        let sanhua_g = mods_dir.join("Sanhua").join("SkinA");
        let verina_g = mods_dir.join("Verina").join("SkinB");

        for d in [&anke_1, &anke_2, &jinhsi_u, &changli_u, &sanhua_g, &verina_g] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(anke_1.join("a.ini"), "[KeySwap]\nkey = K\n").unwrap();
        fs::write(anke_2.join("b.ini"), "[KeyVar]\nkey = no_modifiers k\n").unwrap();
        fs::write(jinhsi_u.join("c.ini"), "[KeyMode]\nkey = ctrl G\n").unwrap();
        fs::write(changli_u.join("d.ini"), "[KeyMode]\nkey = Control G\n").unwrap();
        fs::write(
            sanhua_g.join("e.ini"),
            "[KeyCycle]\ncondition = $active == 1\nkey = alt H\n",
        )
        .unwrap();
        fs::write(
            verina_g.join("f.ini"),
            "[KeyCycle]\ncondition = $object_detected\nkey = Alt h\n",
        )
        .unwrap();

        let report =
            audit_game_mods_conflicts("wuthering-waves", &mods_dir.to_string_lossy(), None, &[], true);

        let same_char = report
            .items
            .iter()
            .find(|i| i.id == "hotkey:char:Anke:k")
            .expect("expected same-character hotkey collision");
        assert_eq!(same_char.severity, "warning");
        assert_eq!(same_char.category, "hotkey-collision");

        let cross_unguarded = report
            .items
            .iter()
            .find(|i| i.id == "hotkey:global-unguarded:ctrl+g")
            .expect("expected unguarded global hotkey collision");
        assert_eq!(cross_unguarded.severity, "warning");
        assert_eq!(cross_unguarded.category, "hotkey-collision");

        let cross_guarded = report
            .items
            .iter()
            .find(|i| i.id == "hotkey:cross-char:alt+h")
            .expect("expected guarded cross-character hotkey info");
        assert_eq!(cross_guarded.severity, "info");
        assert_eq!(cross_guarded.category, "hotkey-collision");

        let _ = fs::remove_dir_all(&root);
    }
}
