//! The `pragma-bench tui` payload: a ratatui TUI that owns its own scroll and
//! reports, on every painted frame, exactly how much input it has processed.
//!
//! The benchmark never asks the terminal "did my keystroke arrive" — it reads
//! this payload's first row, which is a machine-readable status line. That row
//! is the only contract between the payload and the injected runner; everything
//! else on screen is there for a human watching the run.
//!
//! Scroll is intercepted here rather than left to xterm: the payload turns on
//! mouse capture, so xterm stops scrolling its own scrollback and instead
//! encodes each wheel notch as a mouse report on the PTY. That is the path a
//! real TUI (an editor, a pager, a coding agent) puts a user's trackpad through,
//! including the desktop app's wheel pacing, and it is what
//! [`ScrollTui`](crate::scenarios::Scenario::ScrollTui) measures.
//!
//! The same payload has a second job. With `--auto-ms` it stops waiting for
//! input and repaints on a timer instead, scrolling itself forever — that is
//! what the run's background tabs are, so the measured tab is measured next to
//! the load of a real workspace rather than in an otherwise idle window.

use std::io::{self, Stdout};
use std::time::Duration;

use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseEvent, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Gauge, Paragraph};
use ratatui::{Frame, Terminal};

use crate::corpus;

/// Longest run of typed characters kept for display. The typing scenario sends
/// several hundred, and a pane that grew without bound would change how much
/// text is redrawn as the run progressed.
const INPUT_WINDOW: usize = 96;

/// Options for the TUI payload, mirrored by `pragma-bench tui`'s flags.
pub struct TuiOptions {
    pub lines: usize,
    pub step: usize,
    pub marker_prefix: String,
    /// Repaint interval for a background load tab. `None` is the measured
    /// payload: it paints once per input event and nothing else, so a frame is
    /// always attributable to the input that caused it.
    pub auto_ms: Option<u64>,
}

/// Everything the payload paints, and the counters the runner reads back.
struct State {
    lines: usize,
    step: usize,
    marker_prefix: String,
    /// Index of the topmost visible corpus line.
    offset: usize,
    /// Input events processed, of any kind. Monotonic.
    seq: u64,
    keys: u64,
    wheel: u64,
    frame: u64,
    /// Self-driven repaints, in a background load tab. Never bumped by input, so
    /// it can never be confused with one of the counters the runner times.
    ticks: u64,
    auto: Option<Duration>,
    input: String,
    last_key: String,
}

impl State {
    fn new(options: &TuiOptions) -> Self {
        Self {
            lines: options.lines.max(1),
            step: options.step.max(1),
            marker_prefix: options.marker_prefix.clone(),
            offset: 0,
            seq: 0,
            keys: 0,
            wheel: 0,
            frame: 0,
            ticks: 0,
            auto: options.auto_ms.map(Duration::from_millis),
            input: String::new(),
            last_key: "none".to_string(),
        }
    }

    /// The status row the injected runner parses. Painted at row 0 so a reader
    /// needs one buffer line, not a scan of the screen.
    fn status(&self) -> String {
        format!(
            "{} seq={} off={} keys={} wheel={} frame={} ticks={} lines={}",
            self.marker_prefix,
            self.seq,
            self.offset,
            self.keys,
            self.wheel,
            self.frame,
            self.ticks,
            self.lines
        )
    }

    fn on_key(&mut self, key: KeyEvent) {
        self.seq += 1;
        self.keys += 1;
        self.last_key = describe_key(key);
        if let KeyCode::Char(character) = key.code {
            if !key.modifiers.contains(KeyModifiers::CONTROL) {
                self.input.push(character);
                while self.input.chars().count() > INPUT_WINDOW {
                    self.input.remove(0);
                }
            }
        }
    }

    fn on_mouse(&mut self, mouse: MouseEvent, viewport_rows: usize) {
        // Wrapping rather than clamping at the ends. The runner times a scroll
        // by watching `off` change, so an offset that stopped moving because the
        // corpus ran out would be recorded as a dropped frame — the benchmark
        // would report lag that is really just geometry. Wrapping keeps every
        // wheel notch a visible movement no matter how many are sent.
        let max_offset = self.lines.saturating_sub(viewport_rows.max(1));
        let offset = match mouse.kind {
            MouseEventKind::ScrollDown => self.scrolled_down(viewport_rows),
            MouseEventKind::ScrollUp => {
                if self.offset == 0 {
                    max_offset
                } else {
                    self.offset.saturating_sub(self.step)
                }
            }
            _ => return,
        };
        self.seq += 1;
        self.wheel += 1;
        self.offset = offset;
    }

    /// One self-driven repaint of a background load tab.
    ///
    /// It moves the corpus, so every tick redraws the whole body rather than
    /// letting the renderer's damage tracking skip a screen no real session gets
    /// to skip — the point of these tabs is to cost the app what a workspace of
    /// busy agents costs it. `seq`, `keys` and `wheel` are deliberately left
    /// alone: those are the runner's counters, and a load tab is never measured.
    fn on_tick(&mut self, viewport_rows: usize) {
        self.ticks += 1;
        self.offset = self.scrolled_down(viewport_rows);
    }

    /// The next offset one step down, wrapping to the top at the end of the
    /// corpus so the screen always moves. See [`State::on_mouse`] for why
    /// wrapping rather than clamping is the requirement.
    fn scrolled_down(&self, viewport_rows: usize) -> usize {
        let max_offset = self.lines.saturating_sub(viewport_rows.max(1));
        let next = self.offset.saturating_add(self.step);
        if next > max_offset {
            0
        } else {
            next
        }
    }

    fn percent(&self) -> u16 {
        let max_offset = self.lines.saturating_sub(1).max(1);
        u16::try_from(self.offset * 100 / max_offset)
            .unwrap_or(100)
            .min(100)
    }
}

/// Runs the payload until the user (or the benchmark's teardown) quits it.
pub fn run(options: &TuiOptions) -> io::Result<()> {
    let mut terminal = enter()?;
    let mut state = State::new(options);
    let result = event_loop(&mut terminal, &mut state);
    leave(&mut terminal)?;
    result
}

fn event_loop(
    terminal: &mut Terminal<impl ratatui::backend::Backend>,
    state: &mut State,
) -> io::Result<()> {
    loop {
        // Draw first, then block: every painted frame is the direct answer to
        // exactly one input event, which is what makes a send→paint delta
        // attributable to that input.
        state.frame += 1;
        let mut viewport_rows = 0;
        terminal.draw(|frame| viewport_rows = draw(frame, state))?;
        // A load tab has no one typing into it, so it drives itself: wait at
        // most one interval for input, and repaint anyway when none arrives.
        // The measured payload has no `auto` and blocks here forever, which is
        // what keeps one frame equal to one input event.
        if let Some(interval) = state.auto {
            if !event::poll(interval)? {
                state.on_tick(viewport_rows);
                continue;
            }
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if is_quit(key) {
                    return Ok(());
                }
                state.on_key(key);
            }
            Event::Mouse(mouse) => state.on_mouse(mouse, viewport_rows),
            // A resize repaints on the next iteration without advancing `seq`,
            // so it can never be mistaken for a processed input event.
            _ => {}
        }
    }
}

/// Paints one frame and returns the number of corpus rows the body showed.
fn draw(frame: &mut Frame, state: &State) -> usize {
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(4),
    ])
    .split(frame.area());
    let (status_area, body_area, gauge_area, input_area) = (areas[0], areas[1], areas[2], areas[3]);

    frame.render_widget(
        Paragraph::new(state.status()).style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        status_area,
    );

    let rows = body_area.height as usize;
    frame.render_widget(Paragraph::new(body_lines(state, rows)), body_area);

    frame.render_widget(
        Gauge::default()
            .gauge_style(Style::default().fg(Color::Green))
            .percent(state.percent())
            .label(format!(
                "scrolled {} / {} lines · {} wheel events",
                state.offset, state.lines, state.wheel
            )),
        gauge_area,
    );

    frame.render_widget(input_pane(state), input_area);
    rows
}

fn body_lines(state: &State, rows: usize) -> Vec<Line<'static>> {
    (0..rows)
        .map(|row| {
            let index = state.offset + row;
            if index >= state.lines {
                return Line::from("");
            }
            let gutter = Span::styled(
                format!("{index:>6} │ "),
                Style::default().fg(Color::DarkGray),
            );
            let style = if corpus::is_marker(index) {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            Line::from(vec![gutter, Span::styled(corpus::body(index), style)])
        })
        .collect()
}

fn input_pane(state: &State) -> Paragraph<'static> {
    let text = vec![
        Line::from(vec![
            Span::styled("keys ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                state.keys.to_string(),
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("  last ", Style::default().fg(Color::DarkGray)),
            Span::styled(state.last_key.clone(), Style::default().fg(Color::White)),
        ]),
        Line::from(Span::styled(
            state.input.clone(),
            Style::default().fg(Color::Green),
        )),
    ];
    Paragraph::new(text).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" typing · ctrl-q or ctrl-c to quit "),
    )
}

fn describe_key(key: KeyEvent) -> String {
    let name = match key.code {
        KeyCode::Char(' ') => "space".to_string(),
        KeyCode::Char(character) => character.to_string(),
        KeyCode::Enter => "enter".to_string(),
        KeyCode::Backspace => "backspace".to_string(),
        KeyCode::Tab => "tab".to_string(),
        other => format!("{other:?}").to_lowercase(),
    };
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        format!("ctrl-{name}")
    } else {
        name
    }
}

fn is_quit(key: KeyEvent) -> bool {
    if key.code == KeyCode::F(10) {
        return true;
    }
    key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c' | 'q'))
}

fn enter() -> io::Result<Terminal<ratatui::backend::CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    // Mouse capture is the whole point of the scroll scenario: with it on, xterm
    // forwards wheel notches to this process instead of scrolling its scrollback.
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    Terminal::new(ratatui::backend::CrosstermBackend::new(stdout))
}

fn leave(terminal: &mut Terminal<ratatui::backend::CrosstermBackend<Stdout>>) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State::new(&TuiOptions {
            lines: 5000,
            step: 3,
            marker_prefix: "PRAGMABENCH".to_string(),
            auto_ms: None,
        })
    }

    fn wheel(kind: MouseEventKind) -> MouseEvent {
        MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[test]
    fn status_row_carries_every_counter_the_runner_reads() {
        let mut state = state();
        state.on_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
        state.on_mouse(wheel(MouseEventKind::ScrollDown), 40);
        let status = state.status();
        assert!(status.starts_with("PRAGMABENCH seq=2 "), "got {status}");
        assert!(status.contains("keys=1"), "got {status}");
        assert!(status.contains("wheel=1"), "got {status}");
        assert!(status.contains("off=3"), "got {status}");
    }

    #[test]
    fn every_wheel_notch_moves_the_offset_however_many_arrive() {
        let mut state = state();
        let mut previous = state.offset;
        for direction in [MouseEventKind::ScrollDown, MouseEventKind::ScrollUp] {
            for _ in 0..10_000 {
                state.on_mouse(wheel(direction), 40);
                assert_ne!(
                    state.offset, previous,
                    "a wheel notch left the offset where it was, which the runner cannot \
                     distinguish from a dropped frame"
                );
                previous = state.offset;
            }
        }
    }

    #[test]
    fn the_offset_wraps_at_both_ends_rather_than_sticking() {
        let mut state = state();
        state.on_mouse(wheel(MouseEventKind::ScrollUp), 40);
        assert_eq!(state.offset, 5000 - 40, "up from the top wraps to the end");
        state.offset = 4959;
        state.on_mouse(wheel(MouseEventKind::ScrollDown), 40);
        assert_eq!(state.offset, 0, "down past the end wraps to the top");
    }

    #[test]
    fn a_load_tab_repaints_itself_without_touching_the_runners_counters() {
        let mut state = state();
        for _ in 0..2000 {
            let before = state.offset;
            state.on_tick(40);
            assert_ne!(
                state.offset, before,
                "a load tab that stopped moving stops costing the app anything"
            );
        }
        assert_eq!(state.ticks, 2000);
        // Timing reads `seq`, `keys` and `off`; a self-driven repaint must not
        // look like an input the runner is waiting for.
        assert_eq!((state.seq, state.keys, state.wheel), (0, 0, 0));
    }

    #[test]
    fn the_status_row_names_the_tick_counter_a_load_tab_advances() {
        let mut state = state();
        state.on_tick(40);
        assert!(state.status().contains("ticks=1"), "got {}", state.status());
    }

    #[test]
    fn control_characters_do_not_enter_the_typed_buffer() {
        let mut state = state();
        state.on_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
        state.on_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE));
        assert_eq!(state.input, "y");
        assert_eq!(state.keys, 2);
    }

    #[test]
    fn typed_buffer_stays_bounded() {
        let mut state = state();
        for _ in 0..(INPUT_WINDOW * 3) {
            state.on_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE));
        }
        assert_eq!(state.input.chars().count(), INPUT_WINDOW);
    }

    #[test]
    fn quit_needs_a_modifier_so_typed_letters_cannot_end_the_run() {
        assert!(!is_quit(KeyEvent::new(
            KeyCode::Char('q'),
            KeyModifiers::NONE
        )));
        assert!(is_quit(KeyEvent::new(
            KeyCode::Char('q'),
            KeyModifiers::CONTROL
        )));
        assert!(is_quit(KeyEvent::new(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL
        )));
    }
}
