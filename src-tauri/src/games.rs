use crate::models::{GameDef, Settings};

pub fn builtin_games() -> Vec<GameDef> {
    vec![
        GameDef {
            id: "wuthering-waves".into(),
            name: "鸣潮".into(),
            name_en: Some("Wuthering Waves".into()),
            short_name: "鸣潮".into(),
            short_name_en: Some("WuWa".into()),
            loader: "WWMI".into(),
            exe_hint: Some("Wuthering Waves.exe".into()),
            accent: Some("#5eead4".into()),
            is_custom: None,
            locales: None,
        },
        GameDef {
            id: "honkai-star-rail".into(),
            name: "崩坏：星穹铁道".into(),
            name_en: Some("Honkai: Star Rail".into()),
            short_name: "星穹铁道".into(),
            short_name_en: Some("Star Rail".into()),
            loader: "SRMI".into(),
            exe_hint: Some("StarRail.exe".into()),
            accent: Some("#a78bfa".into()),
            is_custom: None,
            locales: None,
        },
        GameDef {
            id: "zzz".into(),
            name: "绝区零".into(),
            name_en: Some("Zenless Zone Zero".into()),
            short_name: "绝区零".into(),
            short_name_en: Some("ZZZ".into()),
            loader: "ZZMI".into(),
            exe_hint: Some("ZenlessZoneZero.exe".into()),
            accent: Some("#facc15".into()),
            is_custom: None,
            locales: None,
        },
        GameDef {
            id: "endfield".into(),
            name: "明日方舟：终末地".into(),
            name_en: Some("Arknights: Endfield".into()),
            short_name: "终末地".into(),
            short_name_en: Some("Endfield".into()),
            loader: "EFMI".into(),
            exe_hint: Some("Endfield.exe".into()),
            accent: Some("#fb923c".into()),
            is_custom: None,
            locales: None,
        },
        GameDef {
            id: "neverness-to-everness".into(),
            name: "异环".into(),
            name_en: Some("Neverness to Everness".into()),
            short_name: "异环".into(),
            short_name_en: Some("NTE".into()),
            loader: "NEMI".into(),
            exe_hint: Some("NTELauncher.exe".into()),
            accent: Some("#38bdf8".into()),
            is_custom: None,
            locales: None,
        },
    ]
}

pub fn get_all_games(settings: &Settings) -> Vec<GameDef> {
    let mut list = builtin_games();
    list.extend(settings.custom_games.iter().cloned());
    list
}

pub fn get_game(settings: &Settings, game_id: &str) -> Option<GameDef> {
    let trimmed = game_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    get_all_games(settings)
        .into_iter()
        .find(|g| g.id == trimmed)
}

pub fn is_builtin_game(game_id: &str) -> bool {
    builtin_games().iter().any(|g| g.id == game_id)
}

pub fn slugify_game_id(name: &str, existing_ids: &[String]) -> String {
    let mut slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let trimmed = slug.trim_matches('-');
    let base = if trimmed.is_empty() {
        "custom-game".to_string()
    } else {
        trimmed.to_string()
    };

    if !existing_ids.iter().any(|id| id == &base) && !is_builtin_game(&base) {
        return base;
    }

    let mut suffix = 2usize;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !existing_ids.iter().any(|id| id == &candidate) && !is_builtin_game(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

pub fn sanitize_custom_game(
    input: &serde_json::Value,
    existing_ids: &[String],
) -> Result<GameDef, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "Invalid custom game payload".to_string())?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Game name is required".to_string())?;

    let requested_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let id = match requested_id {
        Some(req) => {
            if is_builtin_game(&req) {
                return Err("Cannot overwrite a built-in game".to_string());
            }
            req
        }
        None => slugify_game_id(&name, existing_ids),
    };

    let short_name = obj
        .get("shortName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| name.clone());

    let name_en = obj
        .get("nameEn")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let short_name_en = obj
        .get("shortNameEn")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let loader = obj
        .get("loader")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "XXMI".to_string());

    let exe_hint = obj
        .get("exeHint")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let accent = obj
        .get("accent")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| Some("#5ce1e6".to_string()));

    let locales = obj
        .get("locales")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok());

    Ok(GameDef {
        id,
        name,
        name_en,
        short_name,
        short_name_en,
        loader,
        exe_hint,
        accent,
        is_custom: Some(true),
        locales,
    })
}
