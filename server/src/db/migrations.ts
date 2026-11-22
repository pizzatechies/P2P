/**
 * Append-only list of schema migrations. Index N upgrades user_version N -> N+1.
 * Never edit a migration that has shipped; add a new one instead.
 *
 * Money is always stored as INTEGER minor units (cents) to avoid floating-point error.
 */
/**
 * Each migration runs once, in order, inside a transaction. Changing a table's CHECK constraint means
 * rebuilding it; when other tables point to it, that migration is written as { sql, foreignKeysOff }
 * and runs with foreign-key enforcement off, after which every link is checked before it commits.
 */
export type Migration = string | { sql: string; foreignKeysOff: true };

export const migrations: Migration[] = [
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
  // 9: Trading and ledger records: every trade execution, the demo trading account's cash journal,
  //    daily portfolio valuations and end-of-day ledger snapshots.
  `
  -- One row per executed order (orders here fill in full; a broker order that was partly filled and
  -- then ended is recorded with what filled). realized_pl_cents is NULL when it can't be known
  -- (a broker account whose earlier history Aurex never saw).
  CREATE TABLE trade_fills (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id),
    broker             TEXT NOT NULL CHECK (broker IN ('paper','alpaca')),
    account_type       TEXT NOT NULL CHECK (account_type IN ('demo','real')),
    order_ref          TEXT NOT NULL,          -- Aurex order id (paper) or the broker's order id
    order_id           TEXT,                   -- Aurex order id when the order was placed through Aurex
    symbol             TEXT NOT NULL,
    asset_class        TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','future')),
    side               TEXT NOT NULL CHECK (side IN ('buy','sell')),
    qty                REAL NOT NULL CHECK (qty > 0),
    price              REAL NOT NULL CHECK (price > 0),
    multiplier         REAL NOT NULL DEFAULT 1,
    notional_cents     INTEGER NOT NULL,       -- qty x price x multiplier
    fee_cents          INTEGER NOT NULL DEFAULT 0,
    closed_qty         REAL NOT NULL DEFAULT 0, -- how much of an existing position this fill closed
    cost_basis_cents   INTEGER,                -- cost of the closed part (stocks and crypto)
    realized_pl_cents  INTEGER,
    position_after     REAL,
    avg_cost_after     REAL,
    cash_after_cents   INTEGER,
    placed_by          TEXT NOT NULL DEFAULT 'user',
    source             TEXT NOT NULL DEFAULT 'manual',
    executed_at        TEXT NOT NULL,
    UNIQUE (user_id, broker, order_ref)
  );
  CREATE INDEX trade_fills_user ON trade_fills(user_id, executed_at);
  CREATE INDEX trade_fills_time ON trade_fills(executed_at);
  CREATE TRIGGER trade_fills_no_update BEFORE UPDATE ON trade_fills BEGIN SELECT RAISE(ABORT, 'trade records are immutable'); END;
  CREATE TRIGGER trade_fills_no_delete BEFORE DELETE ON trade_fills BEGIN SELECT RAISE(ABORT, 'trade records are immutable'); END;

  -- Every change to the demo trading account's cash, with the balance after it. The entries for an
  -- account always add up to trading_accounts.cash_cents.
  CREATE TABLE trading_cash_entries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             TEXT NOT NULL REFERENCES users(id),
    kind                TEXT NOT NULL CHECK (kind IN ('opening','buy','sell','futures_pl','fee','reset')),
    amount_cents        INTEGER NOT NULL,
    balance_after_cents INTEGER NOT NULL,
    fill_id             TEXT,
    memo                TEXT,
    created_at          TEXT NOT NULL
  );
  CREATE INDEX trading_cash_entries_user ON trading_cash_entries(user_id, id);
  CREATE TRIGGER trading_cash_no_update BEFORE UPDATE ON trading_cash_entries BEGIN SELECT RAISE(ABORT, 'trading cash entries are immutable'); END;
  CREATE TRIGGER trading_cash_no_delete BEFORE DELETE ON trading_cash_entries BEGIN SELECT RAISE(ABORT, 'trading cash entries are immutable'); END;
  INSERT INTO trading_cash_entries (user_id, kind, amount_cents, balance_after_cents, memo, created_at)
    SELECT user_id, 'opening', cash_cents, cash_cents, 'Balance when trading records began', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM trading_accounts;

  -- What each portfolio was worth at the end of each day (the last valuation that day, UTC).
  CREATE TABLE portfolio_snapshots (
    user_id          TEXT NOT NULL REFERENCES users(id),
    day              TEXT NOT NULL,
    broker           TEXT NOT NULL,
    equity_cents     INTEGER NOT NULL,
    cash_cents       INTEGER NOT NULL,
    positions_cents  INTEGER NOT NULL,
    unrealized_cents INTEGER NOT NULL,
    positions        INTEGER NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, broker, day)
  );

  -- End-of-day ledger totals per currency, by kind of account, with the integrity result. Built from
  -- the immutable entries, so any past day can be recomputed and compared.
  CREATE TABLE ledger_snapshots (
    day              TEXT NOT NULL,
    currency         TEXT NOT NULL,
    customer_cents   INTEGER NOT NULL,   -- what Aurex owes its customers (sum of wallet balances)
    external_cents   INTEGER NOT NULL,
    clearing_cents   INTEGER NOT NULL,
    fees_cents       INTEGER NOT NULL,
    fx_cents         INTEGER NOT NULL,
    journals         INTEGER NOT NULL,   -- journals posted that day in this currency
    volume_cents     INTEGER NOT NULL,   -- money moved that day (sum of credits)
    balanced         INTEGER NOT NULL,   -- 1 when every account type sums to zero
    created_at       TEXT NOT NULL,
    PRIMARY KEY (day, currency)
  );
  CREATE INDEX journals_created ON journals(created_at);
  CREATE INDEX journals_kind ON journals(kind, created_at);
  CREATE INDEX entries_created ON entries(created_at);
  `,
  // 10: Real money: payout review, safeguarding accounts and reconciliation, and transaction monitoring.
  `
  -- Withdrawals that wait for a second person before the money is sent. The funds sit in clearing
  -- meanwhile, so they can't be spent twice; a rejection returns them to the customer.
  ALTER TABLE external_transfers ADD COLUMN review_status TEXT CHECK (review_status IN ('required','approved','rejected'));
  ALTER TABLE external_transfers ADD COLUMN review_reasons TEXT;
  ALTER TABLE external_transfers ADD COLUMN reviewed_by TEXT;
  ALTER TABLE external_transfers ADD COLUMN reviewed_at TEXT;
  ALTER TABLE external_transfers ADD COLUMN review_note TEXT;
  CREATE INDEX external_transfers_review ON external_transfers(created_at) WHERE review_status = 'required';

  -- Where customers' money actually is: safeguarding bank accounts, mobile-money and provider
  -- balances. Account details (numbers, IBANs) are encrypted with MASTER_KEY.
  CREATE TABLE safeguarding_accounts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('bank','mobile_money','payment_provider','custodian','other')),
    institution TEXT NOT NULL,
    currency    TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT 'safeguarding' CHECK (purpose IN ('safeguarding','operating')),
    source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','stripe','wise','flutterwave')),
    details_enc TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  -- Balances as reported by the bank or provider (typed in from a statement, or fetched by API).
  CREATE TABLE safeguarding_balances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL REFERENCES safeguarding_accounts(id),
    balance_minor INTEGER NOT NULL,
    as_of         TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('manual','api')),
    recorded_by   TEXT,
    note          TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX safeguarding_balances_account ON safeguarding_balances(account_id, as_of);
  CREATE TRIGGER safeguarding_balances_no_update BEFORE UPDATE ON safeguarding_balances BEGIN SELECT RAISE(ABORT, 'recorded balances are immutable'); END;
  CREATE TRIGGER safeguarding_balances_no_delete BEFORE DELETE ON safeguarding_balances BEGIN SELECT RAISE(ABORT, 'recorded balances are immutable'); END;

  -- Each comparison of what Aurex owes customers with what it actually holds, per currency.
  CREATE TABLE reconciliations (
    id               TEXT PRIMARY KEY,
    run_at           TEXT NOT NULL,
    run_by           TEXT,
    currency         TEXT NOT NULL,
    owed_minor       INTEGER NOT NULL,
    held_minor       INTEGER NOT NULL,
    difference_minor INTEGER NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('covered','shortfall','unverified')),
    stale_accounts   INTEGER NOT NULL DEFAULT 0,
    details          TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX reconciliations_run ON reconciliations(run_at);
  CREATE TRIGGER reconciliations_no_update BEFORE UPDATE ON reconciliations BEGIN SELECT RAISE(ABORT, 'reconciliations are immutable'); END;
  CREATE TRIGGER reconciliations_no_delete BEFORE DELETE ON reconciliations BEGIN SELECT RAISE(ABORT, 'reconciliations are immutable'); END;

  -- Transaction monitoring: patterns worth a compliance look. Never shown to the customer.
  CREATE TABLE compliance_alerts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    rule        TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
    summary     TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',
    ref         TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','escalated')),
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (rule, ref)
  );
  CREATE INDEX compliance_alerts_status ON compliance_alerts(status, created_at);
  CREATE INDEX compliance_alerts_user ON compliance_alerts(user_id, created_at);
  `,
  // 11: Tamper evidence. Journals and audit events carry a chained HMAC seal (see services/integrity.ts),
  //     and neither can be changed or deleted: only the seal may be rewritten (after a key rotation).
  `
  ALTER TABLE journals ADD COLUMN seal TEXT;
  ALTER TABLE audit_events ADD COLUMN seal TEXT;
  CREATE TRIGGER journals_no_update BEFORE UPDATE OF id, kind, memo, initiator_id, idempotency_key, metadata, created_at ON journals
    BEGIN SELECT RAISE(ABORT, 'journals are immutable'); END;
  CREATE TRIGGER journals_no_delete BEFORE DELETE ON journals BEGIN SELECT RAISE(ABORT, 'journals are immutable'); END;
  CREATE TRIGGER audit_no_update BEFORE UPDATE OF id, user_id, action, ip, details, created_at ON audit_events
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
  `,
  // 12: Sanctions screening: the UN and OFAC lists as downloaded, and a record of every screening.
  `
  CREATE TABLE sanctions_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('individual','entity')),
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    birth_years TEXT NOT NULL DEFAULT '[]',
    programs    TEXT,
    countries   TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX sanctions_entries_list ON sanctions_entries(list);
  CREATE TABLE sanctions_lists (
    list       TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    entries    INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    error      TEXT,
    checked_at TEXT
  );
  -- Evidence that screening happened: who, what was screened, and the outcome (not the name itself).
  CREATE TABLE sanctions_checks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    subject    TEXT NOT NULL,
    result     TEXT NOT NULL CHECK (result IN ('clear','possible_match')),
    matches    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX sanctions_checks_user ON sanctions_checks(user_id, created_at);
  `,
  // 13: A controlled launch: invite codes (stored hashed), who used them, and a waitlist.
  `
  CREATE TABLE invite_codes (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    hint       TEXT NOT NULL,
    label      TEXT,
    max_uses   INTEGER NOT NULL CHECK (max_uses > 0),
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    revoked_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (uses <= max_uses)
  );
  CREATE TABLE invite_redemptions (
    invite_id  TEXT NOT NULL REFERENCES invite_codes(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (invite_id, user_id)
  );
  CREATE TABLE waitlist (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name       TEXT,
    country    TEXT,
    created_at TEXT NOT NULL,
    invited_at TEXT,
    invite_id  TEXT,
    joined_at  TEXT
  );
  `,
  // 14: Aurex Pro subscriptions, paid monthly from the wallet (each charge is a "subscription" journal).
  `
  CREATE TABLE subscriptions (
    user_id              TEXT PRIMARY KEY REFERENCES users(id),
    status               TEXT NOT NULL CHECK (status IN ('active','past_due','canceled')),
    currency             TEXT,
    amount_minor         INTEGER,
    started_at           TEXT NOT NULL,
    current_period_end   TEXT NOT NULL,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    comped               INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    last_attempt_at      TEXT,
    last_charge_journal  TEXT,
    updated_at           TEXT NOT NULL
  );
  CREATE INDEX subscriptions_due ON subscriptions(current_period_end) WHERE status <> 'canceled';
  `,
  // 15: Identity checks against government records (Smile ID): the job and its outcome per submission.
  `
  ALTER TABLE kyc_submissions ADD COLUMN provider TEXT;
  ALTER TABLE kyc_submissions ADD COLUMN provider_job_id TEXT;
  ALTER TABLE kyc_submissions ADD COLUMN provider_status TEXT;
  ALTER TABLE kyc_submissions ADD COLUMN provider_result TEXT;
  CREATE INDEX kyc_submissions_provider_job ON kyc_submissions(provider_job_id) WHERE provider_job_id IS NOT NULL;
  `,
  // 16: Business (merchant) accounts, reviewed by an admin before payments to them carry the merchant fee.
  `
  CREATE TABLE business_profiles (
    user_id             TEXT PRIMARY KEY REFERENCES users(id),
    business_name       TEXT NOT NULL,
    category            TEXT NOT NULL,
    registration_number TEXT,
    country             TEXT NOT NULL,
    website             TEXT,
    status              TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    review_note         TEXT,
    reviewed_by         TEXT,
    reviewed_at         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX business_profiles_status ON business_profiles(status, updated_at);
  `,
  // 17: Password reset links (only a hash of each single-use token is stored).
  `
  CREATE TABLE password_resets (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    sent_at    TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 18: Help and complaints: cases with a reference number, and their messages (staff notes included).
  `
  CREATE TABLE support_cases (
    id                TEXT PRIMARY KEY,
    reference         TEXT NOT NULL UNIQUE,
    user_id           TEXT NOT NULL REFERENCES users(id),
    category          TEXT NOT NULL CHECK (category IN ('question','payment','account','security','complaint','other')),
    is_complaint      INTEGER NOT NULL DEFAULT 0,
    priority          TEXT NOT NULL CHECK (priority IN ('normal','high')),
    subject           TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('open','waiting_customer','resolved')),
    assigned_to       TEXT,
    resolution        TEXT,
    outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('upheld','partly_upheld','not_upheld','withdrawn')),
    due_at            TEXT,
    first_response_at TEXT,
    resolved_at       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX support_cases_user ON support_cases(user_id, updated_at);
  CREATE INDEX support_cases_status ON support_cases(status, updated_at);
  CREATE TABLE support_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     TEXT NOT NULL REFERENCES support_cases(id),
    author_type TEXT NOT NULL CHECK (author_type IN ('customer','staff','system')),
    author_id   TEXT,
    internal    INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX support_messages_case ON support_messages(case_id, id);
  `,
  // 19: Two-person approval for admin changes (custom limits, hand-set identity levels).
  `
  CREATE TABLE admin_requests (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('limits','kyc_level')),
    target_user_id TEXT NOT NULL REFERENCES users(id),
    payload        TEXT NOT NULL,
    reason         TEXT,
    requested_by   TEXT NOT NULL REFERENCES users(id),
    status         TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
    decided_by     TEXT,
    decided_at     TEXT,
    decision_note  TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX admin_requests_status ON admin_requests(status, created_at);
  `,
  // 20: Company checks for business accounts: type, directors and owners (encrypted), documents.
  `
  ALTER TABLE business_profiles ADD COLUMN business_type TEXT NOT NULL DEFAULT 'sole_trader';
  ALTER TABLE business_profiles ADD COLUMN people_enc TEXT;
  CREATE TABLE business_documents (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL CHECK (kind IN ('registration','ownership','other')),
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    data_enc   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX business_documents_user ON business_documents(user_id, created_at);
  `,
  // 21: Customers confirmed as politically exposed persons (enhanced due diligence).
  `
  ALTER TABLE users ADD COLUMN pep_confirmed_at TEXT;
  `,
  // 22: Smile ID selfie comparison (selfie vs the photo on the ID document), next to the government check.
  `
  ALTER TABLE kyc_submissions ADD COLUMN selfie_job_id TEXT;
  ALTER TABLE kyc_submissions ADD COLUMN selfie_status TEXT;
  ALTER TABLE kyc_submissions ADD COLUMN selfie_result TEXT;
  CREATE INDEX kyc_submissions_selfie_job ON kyc_submissions(selfie_job_id) WHERE selfie_job_id IS NOT NULL;
  `,
  // 23: Safeguarding accounts can take their balance from Airtel Money (the source list is a CHECK).
  {
    foreignKeysOff: true,
    sql: `
    CREATE TABLE safeguarding_accounts_new (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('bank','mobile_money','payment_provider','custodian','other')),
      institution TEXT NOT NULL,
      currency    TEXT NOT NULL,
      purpose     TEXT NOT NULL DEFAULT 'safeguarding' CHECK (purpose IN ('safeguarding','operating')),
      source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','stripe','wise','flutterwave','airtel')),
      details_enc TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    INSERT INTO safeguarding_accounts_new (id, name, kind, institution, currency, purpose, source, details_enc, active, created_by, created_at, updated_at)
      SELECT id, name, kind, institution, currency, purpose, source, details_enc, active, created_by, created_at, updated_at FROM safeguarding_accounts;
    DROP TABLE safeguarding_accounts;
    ALTER TABLE safeguarding_accounts_new RENAME TO safeguarding_accounts;
    `,
  },
  // 24: Live selfie captures (Smile ID camera component): the liveness frames, encrypted, until they're
  // sent with the identity check. The selfie itself is stored as the "selfie" document.
  `
  CREATE TABLE kyc_liveness (
    user_id       TEXT PRIMARY KEY REFERENCES users(id),
    selfie_doc_id TEXT NOT NULL,
    frames_enc    TEXT NOT NULL,
    frame_count   INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );
  `,
  // 25: Identity checks for a company's directors and owners (each through a private link).
  `
  CREATE TABLE business_person_checks (
    id               TEXT PRIMARY KEY,
    business_user_id TEXT NOT NULL REFERENCES users(id),
    person_key       TEXT NOT NULL,
    email_enc        TEXT,
    token_hash       TEXT,
    token_expires_at TEXT,
    status           TEXT NOT NULL CHECK (status IN ('invited','submitted')),
    data_enc         TEXT,
    provider         TEXT,
    provider_job_id  TEXT,
    provider_status  TEXT,
    provider_result  TEXT,
    invited_at       TEXT,
    submitted_at     TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (business_user_id, person_key)
  );
  CREATE UNIQUE INDEX business_person_checks_token ON business_person_checks(token_hash) WHERE token_hash IS NOT NULL;
  CREATE TABLE business_person_documents (
    id         TEXT PRIMARY KEY,
    check_id   TEXT NOT NULL REFERENCES business_person_checks(id),
    kind       TEXT NOT NULL CHECK (kind IN ('id_front','id_back','selfie')),
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    data_enc   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX business_person_documents_check ON business_person_documents(check_id);
  `,
  // 26: Case files for compliance alerts: running notes (never changed or deleted) and the decision on
  //     reporting an escalated case to the Financial Intelligence Unit, with the filing reference.
  `
  CREATE TABLE compliance_notes (
    id         TEXT PRIMARY KEY,
    alert_id   TEXT NOT NULL REFERENCES compliance_alerts(id),
    author_id  TEXT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX compliance_notes_alert ON compliance_notes(alert_id, created_at);
  CREATE TRIGGER compliance_notes_no_update BEFORE UPDATE ON compliance_notes BEGIN SELECT RAISE(ABORT, 'case notes cannot be changed'); END;
  CREATE TRIGGER compliance_notes_no_delete BEFORE DELETE ON compliance_notes BEGIN SELECT RAISE(ABORT, 'case notes cannot be deleted'); END;
  ALTER TABLE compliance_alerts ADD COLUMN report_decision TEXT CHECK (report_decision IN ('report','no_report'));
  ALTER TABLE compliance_alerts ADD COLUMN report_reason TEXT;
  ALTER TABLE compliance_alerts ADD COLUMN report_ref TEXT;
  ALTER TABLE compliance_alerts ADD COLUMN reported_on TEXT;
  ALTER TABLE compliance_alerts ADD COLUMN decided_by TEXT;
  ALTER TABLE compliance_alerts ADD COLUMN decided_at TEXT;
  `,
  // 27: The last identity-refresh reminder a customer was sent (stage and due date), so each goes once.
  `
  ALTER TABLE users ADD COLUMN kyc_refresh_notice TEXT;
  `,
  // 28: Complaints: redress paid or offered, and referrals to the regulator or ombudsman.
  `
  ALTER TABLE support_cases ADD COLUMN redress_minor INTEGER;
  ALTER TABLE support_cases ADD COLUMN redress_currency TEXT;
  ALTER TABLE support_cases ADD COLUMN referred_at TEXT;
  ALTER TABLE support_cases ADD COLUMN referred_to TEXT;
  `,
  // 29: Limits by country (each verification level's limits, where a regulator sets its own), changed
  //     through two-person approval like a customer's limits: admin requests can now be country-wide
  //     (no customer). The customer's country is the one in their verified address.
  `
  CREATE TABLE admin_requests_new (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('limits','kyc_level','country_limits')),
    target_user_id TEXT REFERENCES users(id),
    payload        TEXT NOT NULL,
    reason         TEXT,
    requested_by   TEXT NOT NULL REFERENCES users(id),
    status         TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
    decided_by     TEXT,
    decided_at     TEXT,
    decision_note  TEXT,
    created_at     TEXT NOT NULL
  );
  INSERT INTO admin_requests_new (id, kind, target_user_id, payload, reason, requested_by, status, decided_by, decided_at, decision_note, created_at)
    SELECT id, kind, target_user_id, payload, reason, requested_by, status, decided_by, decided_at, decision_note, created_at FROM admin_requests;
  DROP TABLE admin_requests;
  ALTER TABLE admin_requests_new RENAME TO admin_requests;
  CREATE INDEX admin_requests_status ON admin_requests(status, created_at);
  CREATE TABLE country_limits (
    country    TEXT NOT NULL,
    level      INTEGER NOT NULL CHECK (level IN (0, 1, 2)),
    tx_usd     REAL NOT NULL CHECK (tx_usd > 0),
    daily_usd  REAL NOT NULL CHECK (daily_usd > 0),
    note       TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (country, level)
  );
  ALTER TABLE users ADD COLUMN residence_country TEXT;
  `,
  // 30: Record retention: when a closed account's personal data was deleted, and legal holds that keep it.
  `
  ALTER TABLE users ADD COLUMN purged_at TEXT;
  ALTER TABLE users ADD COLUMN legal_hold_at TEXT;
  ALTER TABLE users ADD COLUMN legal_hold_reason TEXT;
  `,
];
