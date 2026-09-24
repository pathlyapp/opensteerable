use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_SCREENSHOT_BASE64_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectDirectoryOptions {
    pub title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectDirectoryResult {
    canceled: bool,
    file_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextFileOptions {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextFileResult {
    canceled: bool,
    file_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotImage {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum CaptureScreenshotResult {
    Success {
        success: bool,
        width: u32,
        height: u32,
    },
    Failure {
        success: bool,
        error: String,
    },
}

#[tauri::command]
pub async fn host_select_directory(
    app: AppHandle,
    options: SelectDirectoryOptions,
) -> Result<SelectDirectoryResult, String> {
    let mut dialog = app.dialog().file();
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    let selected = dialog.blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(SelectDirectoryResult {
            canceled: true,
            file_paths: Vec::new(),
        });
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    Ok(SelectDirectoryResult {
        canceled: false,
        file_paths: vec![path.to_string_lossy().into_owned()],
    })
}

#[tauri::command]
pub async fn host_save_text_file(
    app: AppHandle,
    options: SaveTextFileOptions,
) -> Result<SaveTextFileResult, String> {
    let mut dialog = app.dialog().file();
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        dialog = dialog.set_file_name(default_path);
    }
    let selected = dialog.blocking_save_file();
    let Some(selected) = selected else {
        return Ok(SaveTextFileResult {
            canceled: true,
            file_path: None,
        });
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    fs::write(&path, options.content).map_err(|error| error.to_string())?;
    Ok(SaveTextFileResult {
        canceled: false,
        file_path: Some(path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn host_capture_screenshot(
    image: ScreenshotImage,
) -> Result<CaptureScreenshotResult, String> {
    if image.png_base64.len() > MAX_SCREENSHOT_BASE64_BYTES {
        return Ok(CaptureScreenshotResult::Failure {
            success: false,
            error: "Screenshot exceeds the 32 MB transfer limit".to_string(),
        });
    }
    let png = STANDARD
        .decode(image.png_base64)
        .map_err(|error| error.to_string())?;
    let rgba = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = rgba.dimensions();
    if width != image.width || height != image.height {
        return Ok(CaptureScreenshotResult::Failure {
            success: false,
            error: "Screenshot dimensions changed during transfer".to_string(),
        });
    }
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|error| error.to_string())?;
    Ok(CaptureScreenshotResult::Success {
        success: true,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_screenshot_before_decoding() {
        let result = tauri::async_runtime::block_on(host_capture_screenshot(ScreenshotImage {
            png_base64: "a".repeat(MAX_SCREENSHOT_BASE64_BYTES + 1),
            width: 1,
            height: 1,
        }))
        .expect("command should return a structured failure");
        assert!(matches!(
            result,
            CaptureScreenshotResult::Failure { error, .. }
                if error.contains("32 MB")
        ));
    }
}
