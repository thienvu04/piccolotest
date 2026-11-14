-- Piccolo schema (matches Milestone 2 relational schema & data dictionary)
CREATE TABLE Restaurant (
  restaurant_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_name    VARCHAR(100) NOT NULL,
  google_review_link VARCHAR(255)
);

CREATE TABLE Manager (
  manager_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES Restaurant(restaurant_id),
  manager_name  VARCHAR(100) NOT NULL,
  email         VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL
);

CREATE TABLE Guest (
  guest_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email     VARCHAR(100),
  phone     VARCHAR(20),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE InteractionForm (
  form_number       VARCHAR(12) PRIMARY KEY,
  manager_id        INTEGER NOT NULL REFERENCES Manager(manager_id),
  guest_id          INTEGER NOT NULL REFERENCES Guest(guest_id),
  table_number      VARCHAR(10),
  follow_up_consent CHAR(1) NOT NULL CHECK (follow_up_consent IN ('Y','N')),
  detailed_notes    TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activity_status   VARCHAR(20) NOT NULL DEFAULT 'Open'
    CHECK (activity_status IN ('Open','Hold','Archived','Pending Post','Denied'))
);

CREATE TABLE BasicAspect (
  aspect_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  aspect_name VARCHAR(60) NOT NULL
);

CREATE TABLE FormAspect (
  form_number VARCHAR(12) NOT NULL REFERENCES InteractionForm(form_number) ON DELETE CASCADE,
  aspect_id   INTEGER NOT NULL REFERENCES BasicAspect(aspect_id),
  PRIMARY KEY (form_number, aspect_id)
);

CREATE TABLE ReviewDraft (
  draft_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  form_number  VARCHAR(12) NOT NULL UNIQUE REFERENCES InteractionForm(form_number) ON DELETE CASCADE,
  draft_text   TEXT NOT NULL,
  draft_status VARCHAR(20) NOT NULL DEFAULT 'Drafted'
    CHECK (draft_status IN ('Drafted','Approved','Sent','Deleted')),
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at  TIMESTAMP
);

CREATE TABLE ReviewInvitation (
  invitation_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id          INTEGER NOT NULL REFERENCES ReviewDraft(draft_id) ON DELETE CASCADE,
  link_token        VARCHAR(64) NOT NULL UNIQUE,
  sent_via          VARCHAR(10) NOT NULL CHECK (sent_via IN ('Email','SMS')),
  sent_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  guest_edited_text TEXT,
  guest_response    VARCHAR(20) DEFAULT 'Pending'
    CHECK (guest_response IN ('Pending','Opened Google','Declined','Deleted')),
  responded_at      TIMESTAMP
);

CREATE INDEX idx_form_manager ON InteractionForm(manager_id, created_at);

-- Lookup data: the praise checkboxes
INSERT INTO BasicAspect (aspect_name) VALUES
  ('Food quality and taste'),
  ('Speed of service'),
  ('Friendly staff'),
  ('Atmosphere'),
  ('Value for money'),
  ('Cleanliness'),
  ('Special occasion handling'),
  ('Dietary needs handled');

-- Demo restaurant + manager (login: demo@piccolo.app / piccolo123)
INSERT INTO Restaurant (restaurant_name, google_review_link)
VALUES ('Bella Trattoria', 'https://www.google.com/maps');
INSERT INTO Manager (restaurant_id, manager_name, email, password_hash)
VALUES (1, 'Maria Rossi', 'demo@piccolo.app',
  'pbkdf2$100000$Ox4/dpN0McVjxcm73Qn8sg==$OPAy/dHwTHp4eFFMtnlqLKsWDwELoMSlFd35EpI5xdc=');
