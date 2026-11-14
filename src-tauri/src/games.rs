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
