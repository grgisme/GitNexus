// Fixture for static-gated edge detection.
//
// Layout:
//   - UPGRADERS_ENABLED (false) gates dead branches that should be tagged.
//   - DEBUG (true) gates live branches that should NOT be tagged.
//   - LIVE_FLAG (no value resolution) is treated as live.
//   - All callees (`gated_*` and `live_*`) live in the same file so the
//     CALLS edges resolve cleanly.

pub const UPGRADERS_ENABLED: bool = false;
pub const DEBUG: bool = true;
pub const FEATURE_X: bool = false;

pub fn run() void {
    // Live: not under any if-gate.
    live_unconditional();

    // Gated: simple `if (FALSE)`.
    if (UPGRADERS_ENABLED) {
        gated_simple();
    }

    // Gated: `if (FALSE and other)` — `false and *` is false.
    if (UPGRADERS_ENABLED and DEBUG) {
        gated_and_left();
    }

    // Gated: `if (other and FALSE)` — `* and false` is false.
    if (DEBUG and UPGRADERS_ENABLED) {
        gated_and_right();
    }

    // Gated: `if (FALSE or FALSE)`.
    if (UPGRADERS_ENABLED or FEATURE_X) {
        gated_or_both_false();
    }

    // Live: `if (FALSE or DEBUG)` — DEBUG is true, so the disjunction is true.
    if (UPGRADERS_ENABLED or DEBUG) {
        live_or_one_true();
    }

    // Live: `if (DEBUG)` — the constant is true.
    if (DEBUG) {
        live_under_true_const();
    }

    // Live: condition references an unknown identifier.
    if (some_runtime_flag()) {
        live_under_unknown();
    }
}

fn live_unconditional() void {
    _ = 1;
}

fn gated_simple() void {
    _ = 1;
}

fn gated_and_left() void {
    _ = 1;
}

fn gated_and_right() void {
    _ = 1;
}

fn gated_or_both_false() void {
    _ = 1;
}

fn live_or_one_true() void {
    _ = 1;
}

fn live_under_true_const() void {
    _ = 1;
}

fn live_under_unknown() void {
    _ = 1;
}

fn some_runtime_flag() bool {
    return false;
}
