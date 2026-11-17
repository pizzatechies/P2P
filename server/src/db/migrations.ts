/**
 * Append-only list of schema migrations. Index N upgrades user_version N -> N+1.
 * Never edit a migration that has shipped; add a new one instead.
 *
 * Money is always stored as INTEGER minor units (cents) to avoid floating-point error.
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    handle          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    kyc_level       INTEGER NOT NULL DEFAULT 0,
    default_currency TEXT NOT NULL DEFAULT 'USD',
    totp_secret_enc TEXT,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
    created_at      TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,          -- sha256(token); the raw token only lives in the cookie
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    ip          TEXT,
    user_agent  TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Double-entry ledger -------------------------------------------------------
  CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,
    owner_type     TEXT NOT NULL CHECK (owner_type IN ('user','system')),
    user_id        TEXT REFERENCES users(id),
    code           TEXT,                   -- system accounts: external, fees, fx, clearing
    currency       TEXT NOT NULL,
    balance        INTEGER NOT NULL DEFAULT 0,
    allow_negative INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    CHECK (allow_negative = 1 OR balance >= 0),
    CHECK ((owner_type = 'user' AND user_id IS NOT NULL) OR (owner_type = 'system' AND code IS NOT NULL))
  );
  CREATE UNIQUE INDEX accounts_user_ccy ON accounts(user_id, currency) WHERE owner_type = 'user';
  CREATE UNIQUE INDEX accounts_sys_ccy ON accounts(code, currency) WHERE owner_type = 'system';

  CREATE TABLE journals (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,         -- transfer, deposit, withdrawal, withdrawal_settle, withdrawal_reversal, fx
    memo            TEXT,
    initiator_id    TEXT REFERENCES users(id),
    idempotency_key TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX journals_idem ON journals(initiator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    journal_id  TEXT NOT NULL REFERENCES journals(id),
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    amount      INTEGER NOT NULL CHECK (amount <> 0),   -- signed: + credit to the account, - debit
    currency    TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX entries_account ON entries(account_id, id);
  CREATE INDEX entries_journal ON entries(journal_id);

  -- Ledger rows are immutable: corrections are made with new, reversing journals.
  CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
  CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

  -- Money moving in or out through a payment rail ------------------------------
  CREATE TABLE external_transfers (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    direction       TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
    rail            TEXT NOT NULL,
    currency        TEXT NOT NULL,
    amount          INTEGER NOT NULL CHECK (amount > 0),
    fee             INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL CHECK (status IN ('pending','completed','failed','canceled')),
    provider_ref    TEXT,
    destination     TEXT,                  -- JSON, withdrawals only
    failure_reason  TEXT,
    journal_id      TEXT REFERENCES journals(id),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX external_transfers_user ON external_transfers(user_id, created_at);
  CREATE UNIQUE INDEX external_transfers_ref ON external_transfers(rail, provider_ref) WHERE provider_ref IS NOT NULL;

  CREATE TABLE payment_requests (
    id            TEXT PRIMARY KEY,
    requester_id  TEXT NOT NULL REFERENCES users(id),
    payer_id      TEXT NOT NULL REFERENCES users(id),
    currency      TEXT NOT NULL,
    amount        INTEGER NOT NULL CHECK (amount > 0),
    memo          TEXT,
    status        TEXT NOT NULL CHECK (status IN ('pending','paid','declined','canceled')),
    journal_id    TEXT REFERENCES journals(id),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX payment_requests_payer ON payment_requests(payer_id, status);
  CREATE INDEX payment_requests_requester ON payment_requests(requester_id, status);

  CREATE TABLE audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    action      TEXT NOT NULL,
    ip          TEXT,
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX audit_user ON audit_events(user_id, id);

  -- AI hub ---------------------------------------------------------------------
  CREATE TABLE user_api_keys (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    key_enc     TEXT NOT NULL,             -- AES-256-GCM, see lib/crypto.ts
    key_hint    TEXT NOT NULL,             -- last 4 chars, for display
    extra       TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );

  CREATE TABLE ai_conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX ai_conversations_user ON ai_conversations(user_id, updated_at);

  CREATE TABLE ai_messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content          TEXT NOT NULL,
    provider         TEXT,
    model            TEXT,
    usage            TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX ai_messages_conv ON ai_messages(conversation_id, created_at);

  -- Trading --------------------------------------------------------------------
  CREATE TABLE trading_accounts (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    broker         TEXT NOT NULL DEFAULT 'paper' CHECK (broker IN ('paper','alpaca')),
    cash_cents     INTEGER NOT NULL,       -- paper broker only
    starting_cents INTEGER NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE positions (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    qty        REAL NOT NULL,
    avg_cost   REAL NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );

  CREATE TABLE orders (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker           TEXT NOT NULL,
    broker_order_id  TEXT,
    symbol           TEXT NOT NULL,
    side             TEXT NOT NULL CHECK (side IN ('buy','sell')),
    type             TEXT NOT NULL CHECK (type IN ('market','limit')),
    qty              REAL NOT NULL CHECK (qty > 0),
    limit_price      REAL,
    status           TEXT NOT NULL,        -- new, filled, canceled, rejected (+ broker statuses)
    filled_qty       REAL NOT NULL DEFAULT 0,
    filled_avg_price REAL,
    source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
    signal_id        TEXT,
    reject_reason    TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX orders_user ON orders(user_id, created_at);
  CREATE INDEX orders_open ON orders(status) WHERE status = 'new';

  CREATE TABLE watchlist (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );

  CREATE TABLE ai_signals (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol         TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('buy','sell','hold')),
    confidence     REAL NOT NULL,
    suggested_qty  REAL NOT NULL DEFAULT 0,
    price          REAL NOT NULL,
    stop_loss      REAL,
    take_profit    REAL,
    horizon        TEXT,
    rationale      TEXT NOT NULL,
    risks          TEXT NOT NULL DEFAULT '[]',
    indicators     TEXT NOT NULL DEFAULT '{}',
    executed_order_id TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX ai_signals_user ON ai_signals(user_id, created_at);
  `,
  /* 2: AI autopilot + free AI allowance */ `
  ALTER TABLE orders ADD COLUMN placed_by TEXT NOT NULL DEFAULT 'user';

  CREATE TABLE autopilot_settings (
    user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled            INTEGER NOT NULL DEFAULT 0,
    mode               TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','approve')),
    provider           TEXT NOT NULL DEFAULT 'rules',
    model              TEXT,
    symbols            TEXT NOT NULL DEFAULT '[]',   -- empty list = use the watchlist
    interval_min       INTEGER NOT NULL DEFAULT 30,
    max_position_pct   REAL NOT NULL DEFAULT 5,
    max_exposure_pct   REAL NOT NULL DEFAULT 50,
    max_trades_per_day INTEGER NOT NULL DEFAULT 5,
    max_daily_loss_pct REAL NOT NULL DEFAULT 3,
    min_confidence     REAL NOT NULL DEFAULT 0.6,
    use_exits          INTEGER NOT NULL DEFAULT 1,
    allow_live         INTEGER NOT NULL DEFAULT 0,
    acknowledged_at    TEXT,
    paused_reason      TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    day_date           TEXT,
    day_start_equity   REAL,
    last_run_at        TEXT,
    next_run_at        TEXT,
    updated_at         TEXT NOT NULL
  );
  CREATE INDEX autopilot_due ON autopilot_settings(enabled, next_run_at);

  CREATE TABLE autopilot_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,     -- run, buy, sell, exit, hold, approval, skip, pause, error
    symbol     TEXT,
    message    TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    order_id   TEXT,
    signal_id  TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX autopilot_events_user ON autopilot_events(user_id, id);

  -- Stop-loss / take-profit levels for positions the autopilot opened.
  CREATE TABLE autopilot_guards (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    stop_loss   REAL,
    take_profit REAL,
    signal_id   TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );

  -- Requests made with server-provided AI keys, per user per UTC day (free allowance).
  CREATE TABLE ai_usage (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  `,
  /* 3: connections to outside financial institutions (aggregators) */ `
  CREATE TABLE linked_connections (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('pending','active','error')),
    external_id    TEXT,               -- the aggregator's item / connection / account id
    secret_enc     TEXT,               -- access token, AES-256-GCM (see lib/crypto.ts)
    institution    TEXT,
    country        TEXT,
    error          TEXT,
    meta           TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_synced_at TEXT
  );
  CREATE INDEX linked_connections_user ON linked_connections(user_id, created_at);

  -- Balances read from outside institutions. Informational only: never part of the ledger.
  CREATE TABLE linked_accounts (
    id            TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES linked_connections(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL,       -- bank, savings, card, credit, loan, investment, wallet, other
    mask          TEXT,
    currency      TEXT,
    balance       REAL,
    available     REAL,
    updated_at    TEXT NOT NULL,
    UNIQUE (connection_id, external_id)
  );
  CREATE INDEX linked_accounts_user ON linked_accounts(user_id);

  -- A user's identity at an aggregator that keys data by customer (Salt Edge, SnapTrade).
  CREATE TABLE provider_customers (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    external_id TEXT NOT NULL,
    secret_enc  TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  `,
  // 4: USD value for linked holdings Aurex can't price itself (e.g. crypto from Coinbase).
  `
  ALTER TABLE linked_accounts ADD COLUMN value_usd REAL;
  `,
  // 5: Account protection - lockouts, 2FA replay protection, recovery codes, security holds,
  // session activity and re-authentication, and in-app security alerts.
  `
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN lockouts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN security_hold_until TEXT;
  ALTER TABLE users ADD COLUMN password_changed_at TEXT;

  ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
  ALTER TABLE sessions ADD COLUMN reauth_at TEXT;

  -- One-time 2FA recovery codes; only their SHA-256 is stored.
  CREATE TABLE recovery_codes (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, code_hash)
  );

  CREATE TABLE security_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    ip         TEXT,
    created_at TEXT NOT NULL,
    read_at    TEXT
  );
  CREATE INDEX security_alerts_user ON security_alerts(user_id, id);
  `,
  // 6: What the recipient needs to collect a payout (e.g. a MoneyGram reference number for cash pickup).
  `
  ALTER TABLE external_transfers ADD COLUMN payout_reference TEXT;
  `,
  // 7: Email verification, the trading academy and real-account upgrades.
  `
  ALTER TABLE users ADD COLUMN email_verified_at TEXT;

  -- One pending email code per user; only its hash is stored.
  CREATE TABLE email_codes (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    TEXT NOT NULL
  );

  -- Passed lesson quizzes.
  CREATE TABLE learning_progress (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id      TEXT NOT NULL,
    score        REAL NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  -- Applications to upgrade from a demo to a real (live brokerage) account.
  -- Personal details are encrypted with MASTER_KEY (AES-256-GCM).
  CREATE TABLE live_applications (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
    data_enc      TEXT,
    assessment    TEXT,
    submitted_at  TEXT,
    reviewed_at   TEXT,
    reviewer_id   TEXT,
    review_note   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX live_applications_status ON live_applications(status, submitted_at);
  `,
  // 8: Real-account provisions: account numbers, identity verification (KYC) with limit tiers,
  //    per-user limit overrides, account closure and admin notes.
  `
  ALTER TABLE users ADD COLUMN account_number TEXT;
  CREATE UNIQUE INDEX users_account_number ON users(account_number) WHERE account_number IS NOT NULL;
  ALTER TABLE users ADD COLUMN closed_at TEXT;
  -- Admin overrides of the verification-level limits (USD); NULL means "use the level's limits".
  ALTER TABLE users ADD COLUMN limit_tx_usd REAL;
  ALTER TABLE users ADD COLUMN limit_daily_usd REAL;

  -- Identity verification. Level 1: identity (ID document and selfie). Level 2: enhanced (proof of
  -- address and source of funds). Personal details are encrypted with MASTER_KEY (AES-256-GCM).
  CREATE TABLE kyc_submissions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level         INTEGER NOT NULL CHECK (level IN (1, 2)),
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
    data_enc      TEXT,
    submitted_at  TEXT,
    reviewed_at   TEXT,
    reviewer_id   TEXT,
    review_note   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX kyc_submissions_user ON kyc_submissions(user_id, level, created_at);
  CREATE INDEX kyc_submissions_status ON kyc_submissions(status, submitted_at);

  -- Identity documents (ID photos, selfie, proof of address), encrypted at rest.
  CREATE TABLE kyc_documents (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('id_front','id_back','selfie','proof_of_address')),
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    data_enc    TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX kyc_documents_user ON kyc_documents(user_id, kind, created_at);

  -- Internal notes admins keep on an account.
  CREATE TABLE account_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL,
    note        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX account_notes_user ON account_notes(user_id, id);
  `,
];
