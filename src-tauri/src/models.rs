use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLocaleLabel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    pub short_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_name_en: Option<String>,
    pub loader: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_custom: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locales: Option<HashMap<String, GameLocaleLabel>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSettings {
    #[serde(default)]
    pub mods_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    #[serde(default = "default_auto")]
    pub language: String,
    #[serde(default = "default_custom")]
    pub sort_characters: String,
    #[serde(default = "default_name")]
    pub sort_mods: String,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default = "default_all")]
    pub character_filter: String,
    #[serde(default = "default_overlay_hotkey")]
    pub overlay_hotkey: String,
    #[serde(default = "default_reload_hotkey")]
    pub reload_hotkey: String,
    #[serde(default = "default_true")]
    pub overlay_pinned: bool,
    #[serde(default = "default_multi")]
    pub mod_select_mode: String,
    #[serde(default = "default_true")]
    pub allow_hotkey_send: bool,
    #[serde(default = "default_true")]
    pub env_check_enabled: bool,
    #[serde(default)]
    pub env_check_never_prompt: bool,
    #[serde(default)]
    pub auto_reload_f10: bool,
    #[serde(default)]
    pub auto_reload_mod_toggle: bool,
    #[serde(default = "default_true")]
    pub auto_reload_mod_preset: bool,
    #[serde(default = "default_true")]
    pub auto_reload_roster_preset: bool,
    #[serde(default)]
    pub auto_sync_before_save_preset: bool,
    #[serde(default)]
    pub variable_ignore_rules: Vec<String>,
    #[serde(default = "default_delay")]
    pub post_reload_sync_delay: f64,
    #[serde(default = "default_recent_count")]
    pub recent_mod_count: usize,
    #[serde(default = "default_quit")]
    pub close_behavior: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            language: default_auto(),
            sort_characters: default_custom(),
            sort_mods: default_name(),
            show_hidden: false,
            character_filter: default_all(),
            overlay_hotkey: default_overlay_hotkey(),
            reload_hotkey: default_reload_hotkey(),
            overlay_pinned: true,
            mod_select_mode: default_multi(),
            allow_hotkey_send: true,
            env_check_enabled: true,
            env_check_never_prompt: false,
            auto_reload_f10: false,
            auto_reload_mod_toggle: false,
            auto_reload_mod_preset: true,
            auto_reload_roster_preset: true,
            auto_sync_before_save_preset: false,
            variable_ignore_rules: Vec::new(),
            post_reload_sync_delay: default_delay(),
            recent_mod_count: default_recent_count(),
            close_behavior: default_quit(),
            extra: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub delete_archive_after: bool,
    #[serde(default)]
    pub overwrite_existing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roster_remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMod {
    pub game_id: String,
    pub character_folder: String,
    pub mod_folder: String,
    pub name: String,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default = "default_active_game")]
    pub active_game_id: String,
    #[serde(default)]
    pub xxmi_root: Option<String>,
    #[serde(default)]
    pub games: HashMap<String, GameSettings>,
    #[serde(default)]
    pub custom_games: Vec<GameDef>,
    #[serde(default)]
    pub hidden_game_ids: Vec<String>,
    #[serde(default)]
    pub only_show_configured_games: bool,
    #[serde(default)]
    pub ui: UiSettings,
    #[serde(default)]
    pub import: ImportSettings,
    #[serde(default)]
    pub character_orders: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub mod_orders: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub recent_mods: Vec<RecentMod>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_en_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataStore {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub games: HashMap<String, HashMap<String, CharacterMeta>>,
    #[serde(default)]
    pub roster_initialized: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInfo {
    pub folder: String,
    pub display_name: String,
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_en_name: Option<String>,
    pub mod_count: usize,
    pub enabled_count: usize,
    pub hidden_count: usize,
    pub has_cover: bool,
    pub cover_url: Option<String>,
    pub known: bool,
    pub order: usize,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInfo {
    pub character_folder: String,
    pub folder_name: String,
    pub name: String,
    pub enabled: bool,
    pub has_ini: bool,
    pub preview_url: Option<String>,
    pub updated_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModHotkey {
    pub section: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModDetails {
    pub character_folder: String,
    pub folder_name: String,
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub file_count: usize,
    pub size_bytes: u64,
    pub updated_at: f64,
    pub ini_files: Vec<String>,
    pub hotkeys: Vec<ModHotkey>,
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSnapshot {
    pub game: GameDef,
    pub settings: GameSettings,
    pub characters: Vec<CharacterInfo>,
    pub total_mods: usize,
    pub enabled_mods: usize,
    pub mods_path_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub pending_preset_count: usize,
    pub settings: Settings,
    pub games: Vec<GameDef>,
    pub snapshot: Option<GameSnapshot>,
    pub app_version: String,
    pub roster_map: HashMap<String, Vec<String>>,
    pub custom_locales: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub electron: String,
    pub node: String,
    pub chrome: String,
    pub platform: String,
    pub user_data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reloaded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChangedEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_preset_count: Option<usize>,
}

fn default_auto() -> String {
    "auto".to_string()
}
fn default_custom() -> String {
    "custom".to_string()
}
fn default_name() -> String {
    "name".to_string()
}
fn default_all() -> String {
    "all".to_string()
}
fn default_overlay_hotkey() -> String {
    "Alt+Shift+M".to_string()
}
fn default_reload_hotkey() -> String {
    "F10".to_string()
}
fn default_multi() -> String {
    "multi".to_string()
}
fn default_quit() -> String {
    "quit".to_string()
}
fn default_active_game() -> String {
    "wuthering-waves".to_string()
}
fn default_true() -> bool {
    true
}
fn default_delay() -> f64 {
    6.0
}
fn default_recent_count() -> usize {
    8
}
fn default_schema_version() -> u32 {
    1
}

fn default_roster_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub zh: String,
    #[serde(default)]
    pub en: String,
    #[serde(default)]
    pub pinyin: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RosterCacheFile {
    #[serde(default = "default_roster_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub games: HashMap<String, Vec<RosterEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSyncStatus {
    pub remote_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub game_counts: HashMap<String, usize>,
    pub has_remote_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSyncResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_or_updated: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_folders_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RosterSyncStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoDetectPathsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xxmi_root: Option<String>,
    pub detected_games: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCharacterInput {
    pub folder: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub cover_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGameMutationResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<GameSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleVisibilityResult {
    pub ok: bool,
    pub hidden_game_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlyConfiguredResult {
    pub ok: bool,
    pub only_show_configured_games: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentShaderCacheInfo {
    pub enabled_in_ini: Option<bool>,
    pub dir_exists: bool,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentShaderFixesInfo {
    pub dir_exists: bool,
    pub file_count: usize,
    pub sample_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheck {
    pub game_id: String,
    pub mods_path: String,
    pub root: String,
    pub d3dx_path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shader_cache: Option<EnvironmentShaderCacheInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shader_fixes: Option<EnvironmentShaderFixesInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearShaderCacheResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freed_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
