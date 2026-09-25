use super::node_compatible_path;
use std::path::Path;

#[cfg(not(windows))]
#[test]
fn packaged_path_is_unchanged_off_windows() {
    let path = Path::new("/opt/Aroli/node-host");
    assert_eq!(node_compatible_path(path), path);
}

#[cfg(windows)]
#[test]
fn strips_windows_verbatim_disk_prefix() {
    assert_eq!(
        node_compatible_path(Path::new(r"\\?\C:\Aroli\node-host")),
        Path::new(r"C:\Aroli\node-host")
    );
}

#[cfg(windows)]
#[test]
fn converts_windows_verbatim_unc_prefix() {
    assert_eq!(
        node_compatible_path(Path::new(r"\\?\UNC\server\share\node-host")),
        Path::new(r"\\server\share\node-host")
    );
}
