//! A terminal running Claude Code on a Helm request.
//!
//! "Start with Claude" on a request ends here: Helm hands over the prompt and
//! the project's folder on this PC, and this opens a new Windows Terminal tab
//! in that folder with Claude Code already reading the prompt — or a plain
//! console when Windows Terminal is not installed.
//!
//! ⚠️ **The prompt is somebody else's text** — a request a client wrote,
//! shaped by Helm — and it crosses up to three command-line parsers on the way
//! (ours to wt.exe, wt.exe's own, and wt.exe's to Claude). Nothing here may
//! build a shell string: every hop is an argument, quoted for the parser that
//! reads it, and no hop goes through `cmd.exe`. See `claude` on why that last
//! one is the reason Claude's own .exe is looked up rather than `claude`.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A console of its own for the child: the app itself has none (it is a
/// windowed build), and Claude Code is a console program.
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// How Claude Code is started on this machine: a program and any arguments
/// that come before the prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub lead: Vec<String>,
}

/// One argument, quoted so `CommandLineToArgvW` (and the MSVC runtime every
/// console program here parses with) reads back exactly this string.
///
/// ⚠️ The rule that bites is the backslashes: they are literal EXCEPT in front
/// of a quote, where each pair is one backslash and an odd one escapes the
/// quote. So a folder ending in `\` — `C:\CODE\esono\` — quoted naively as
/// `"C:\CODE\esono\"` swallows its own closing quote and every argument after
/// it runs into this one.
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '"')) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
        }
        out.push(c);
        slashes = 0;
    }
    // Doubled, because the closing quote follows them.
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

/// The prompt as Windows Terminal will pass it on intact.
///
/// ⚠️ wt.exe does not hand its arguments to the child as it got them. It
/// splits the line into commands at every unescaped `;` (so a prompt saying
/// "fix the cart; then the gallery" would open a second, broken tab), and it
/// joins what is left back into a command line by wrapping each argument that
/// has a space in plain quotes — WITHOUT escaping a quote inside it. So:
///
/// - every `;` is written `\;`, which wt turns back into `;`;
/// - a `"` becomes `'`, because there is no spelling of it that survives a
///   join that does not escape — and in a prompt the two read the same to
///   Claude;
/// - a trailing `\` gets a space after it, or it would escape the quote wt
///   puts round the argument;
/// - a leading `-` gets a space before it, or wt reads it as one of its own
///   options.
///
/// The plain-console route needs none of this: Rust's own quoting is exact
/// for an .exe, and that route passes the prompt untouched.
pub fn for_wt(prompt: &str) -> String {
    let mut text = prompt.replace('"', "'").replace(';', "\\;");
    if text.ends_with('\\') {
        text.push(' ');
    }
    if text.starts_with('-') {
        text.insert(0, ' ');
    }
    text
}

/// Everything after `wt.exe` on its command line.
///
/// `new-tab` named rather than implied, so `-d` is unambiguously the tab's
/// directory; and wt stops reading options at the first positional, so the
/// program and the prompt after it are passed through as the commandline.
pub fn wt_line(folder: &Path, launch: &Launch, prompt: &str) -> String {
    let mut parts = vec![
        "new-tab".to_string(),
        "-d".to_string(),
        quote(&folder.to_string_lossy()),
        quote(&launch.program.to_string_lossy().replace(';', "\\;")),
    ];
    parts.extend(launch.lead.iter().map(|arg| quote(&for_wt(arg))));
    parts.push(quote(&for_wt(prompt)));
    parts.join(" ")
}

/// Where Claude Code's own program is, given where to look.
///
/// ⚠️ **Never `claude` by name.** On this machine it is `claude.cmd` — the
/// npm shim — and a .cmd runs under `cmd.exe`, which re-reads the whole line:
/// `%` expands, a `"` in the text ends the quoting and an `&` after it runs a
/// second command. A prompt is somebody else's words, so that is a command
/// injection, and a multi-line prompt cannot be passed through cmd at all.
/// The shim only forwards to a real program, so that program is found and
/// started directly:
///
/// 1. the native installer's `~/.local/bin/claude.exe`;
/// 2. a `claude.exe` anywhere on `PATH`;
/// 3. beside an npm `claude.cmd`, the package's own `bin/claude.exe` (what
///    the shim itself runs) or, for an older package, `node cli.js`.
///
/// Pure over `exists`, so the order is tested without a machine.
pub fn find_claude(home: Option<&Path>, path: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<Launch> {
    let program = |at: PathBuf| Launch { program: at, lead: Vec::new() };
    if let Some(home) = home {
        let native = home.join(".local").join("bin").join("claude.exe");
        if exists(&native) {
            return Some(program(native));
        }
    }
    for dir in path {
        let exe = dir.join("claude.exe");
        if exists(&exe) {
            return Some(program(exe));
        }
    }
    for dir in path {
        if !exists(&dir.join("claude.cmd")) {
            continue;
        }
        let package = dir.join("node_modules").join("@anthropic-ai").join("claude-code");
        let exe = package.join("bin").join("claude.exe");
        if exists(&exe) {
            return Some(program(exe));
        }
        let script = package.join("cli.js");
        if exists(&script) {
            let node = std::iter::once(dir.clone()).chain(path.iter().cloned())
                .map(|d| d.join("node.exe"))
                .find(|node| exists(node))?;
            return Some(Launch { program: node, lead: vec![script.to_string_lossy().into_owned()] });
        }
    }
    None
}

fn search_path() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|raw| std::env::split_paths(&raw).collect()).unwrap_or_default()
}

/// Windows Terminal's own launcher, if it is installed.
///
/// ⚠️ An App Execution Alias: a reparse point that `CreateProcess` can start
/// but that `Path::is_file` (which follows it) calls missing. `symlink_metadata`
/// reads the alias itself.
fn windows_terminal() -> Option<PathBuf> {
    let local = dirs::data_local_dir()?;
    let alias = local.join("Microsoft").join("WindowsApps").join("wt.exe");
    if std::fs::symlink_metadata(&alias).is_ok() {
        return Some(alias);
    }
    search_path().into_iter().map(|dir| dir.join("wt.exe")).find(|wt| std::fs::symlink_metadata(wt).is_ok())
}

/// Start Claude Code in `folder` on `prompt`. Says where it went.
pub fn open(folder: &Path, prompt: &str) -> Result<&'static str, String> {
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder on this PC.", folder.display()));
    }
    let home = dirs::home_dir();
    let launch = find_claude(home.as_deref(), &search_path(), &|at: &Path| at.is_file())
        .ok_or("Claude Code isn't installed where codenotch can find it.")?;
    if let Some(wt) = windows_terminal() {
        /* ⚠️ `raw_arg`, because wt's line is built for wt's own parser (see
         * `for_wt`) and Rust's quoting would quote it a second time. */
        let started = Command::new(&wt).raw_arg(wt_line(folder, &launch, prompt)).current_dir(folder).spawn();
        match started {
            Ok(_) => return Ok("Windows Terminal"),
            Err(error) => crate::log::note(&format!("claude: wt would not start ({error}), using a console")),
        }
    }
    Command::new(&launch.program)
        .args(&launch.lead)
        .arg(prompt)
        .current_dir(folder)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| "a console")
        .map_err(|error| format!("Couldn't start Claude Code: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `CommandLineToArgvW` would make of a line, for the arguments these
    /// tests produce (no leading program-name rules needed).
    fn argv(line: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut chars = line.chars().peekable();
        loop {
            while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
                chars.next();
            }
            if chars.peek().is_none() {
                return out;
            }
            let mut arg = String::new();
            let mut quoted = false;
            let mut slashes = 0usize;
            while let Some(&c) = chars.peek() {
                if c == '\\' {
                    slashes += 1;
                    chars.next();
                    continue;
                }
                if c == '"' {
                    arg.extend(std::iter::repeat_n('\\', slashes / 2));
                    if slashes % 2 == 1 {
                        arg.push('"');
                    } else {
                        quoted = !quoted;
                    }
                    slashes = 0;
                    chars.next();
                    continue;
                }
                arg.extend(std::iter::repeat_n('\\', slashes));
                slashes = 0;
                if !quoted && (c == ' ' || c == '\t') {
                    break;
                }
                arg.push(c);
                chars.next();
            }
            arg.extend(std::iter::repeat_n('\\', slashes));
            out.push(arg);
        }
    }

    #[test]
    fn an_argument_reads_back_exactly() {
        for case in [
            "plain",
            "two words",
            "",
            r"C:\CODE\esono\",
            r#"say "hi" to them"#,
            r#"ends in a quote\""#,
            "line one\nline two",
            r"a \\ b \\",
            "zażółć gęślą jaźń",
        ] {
            assert_eq!(argv(&quote(case)), vec![case.to_string()], "{case:?}");
        }
    }

    #[test]
    fn several_arguments_stay_apart() {
        let line = [r"C:\CODE\esono\", "-d", r#"a "b" c"#].map(quote).join(" ");
        assert_eq!(argv(&line), vec![r"C:\CODE\esono\".to_string(), "-d".into(), r#"a "b" c"#.into()]);
    }

    #[test]
    fn a_prompt_survives_windows_terminal() {
        assert_eq!(for_wt("fix the cart; then the gallery"), r"fix the cart\; then the gallery");
        assert_eq!(for_wt(r#"rename "Koszyk" to "Cart""#), "rename 'Koszyk' to 'Cart'");
        assert_eq!(for_wt(r"a path C:\x\"), "a path C:\\x\\ ");
        assert_eq!(for_wt("--help me"), " --help me");
        // An escaped delimiter already in the text stays a delimiter-free `\;`.
        assert_eq!(for_wt(r"regex \; here"), r"regex \\; here");
    }

    #[test]
    fn the_wt_line_is_wts_own_arguments() {
        let launch = Launch { program: PathBuf::from(r"C:\Users\m\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"), lead: vec![] };
        let line = wt_line(Path::new(r"C:\CODE\sonocars\"), &launch, "Zmiana logo; \"nowe\"\nDzięki");
        let args = argv(&line);
        assert_eq!(args[0], "new-tab");
        assert_eq!(args[1], "-d");
        assert_eq!(args[2], r"C:\CODE\sonocars\", "the folder, trailing backslash and all");
        assert_eq!(args[3], launch.program.to_string_lossy());
        assert_eq!(args[4], "Zmiana logo\\; 'nowe'\nDzięki", "one argument, newline kept, ; escaped for wt");
        assert_eq!(args.len(), 5);
    }

    #[test]
    fn claude_is_found_without_going_through_cmd() {
        let home = PathBuf::from(r"C:\Users\m");
        let npm = PathBuf::from(r"C:\Users\m\AppData\Roaming\npm");
        let path = vec![PathBuf::from(r"C:\Windows"), npm.clone()];
        let shim_exe = npm.join(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe");

        // npm's shim, with the package's own exe beside it: the exe, never the .cmd.
        let have = [npm.join("claude.cmd"), shim_exe.clone()];
        let found = find_claude(Some(&home), &path, &|at| have.iter().any(|h| h == at)).unwrap();
        assert_eq!(found, Launch { program: shim_exe.clone(), lead: vec![] });

        // The native install wins over everything.
        let native = home.join(r".local\bin\claude.exe");
        let have = [native.clone(), npm.join("claude.cmd"), shim_exe.clone()];
        assert_eq!(find_claude(Some(&home), &path, &|at| have.iter().any(|h| h == at)).unwrap().program, native);

        // An older package: node and its script.
        let script = npm.join(r"node_modules\@anthropic-ai\claude-code\cli.js");
        let node = PathBuf::from(r"C:\Windows\node.exe");
        let have = [npm.join("claude.cmd"), script.clone(), node.clone()];
        assert_eq!(
            find_claude(Some(&home), &path, &|at| have.iter().any(|h| h == at)).unwrap(),
            Launch { program: node, lead: vec![script.to_string_lossy().into_owned()] },
        );

        // A lone .cmd with nothing real behind it is not started at all.
        let have = [npm.join("claude.cmd")];
        assert!(find_claude(Some(&home), &path, &|at| have.iter().any(|h| h == at)).is_none());
    }
}
