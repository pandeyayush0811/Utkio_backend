-- Run this once in Supabase Dashboard -> SQL Editor.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now(),

  -- Onboarding data (collected once, right after signup)
  name text,
  age int,
  occupation_type text,   -- student | professional
  class_grade text,       -- only set when occupation_type = 'student'  (e.g. "Class 10", "B.Tech 2nd year")
  profession text,        -- only set when occupation_type = 'professional' (e.g. "Software Engineer")
  city text,
  goal text,              -- interview | daily_confidence | exam_prep | travel | content_creation | general
  self_level text,        -- beginner | intermediate | advanced
  english_sample text,    -- free-text sample, saved now, analyzed later
  daily_time text,        -- 5_10 | 15_20 | 30_plus
  onboarding_completed boolean not null default false
);

-- Chat history: one row per completed voice session, plus one row per
-- turn inside it. Frontend writes turns to local storage during the
-- session and pushes everything here in a single call once it ends
-- (see POST /chat/sessions) — so these tables only ever get one bulk
-- insert per session, not one write per turn.
create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  turn_count int not null default 0,
  created_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  turn_index int not null,
  created_at timestamptz default now()
);

create index if not exists chat_messages_session_id_idx on chat_messages(session_id);
create index if not exists chat_sessions_user_id_idx on chat_sessions(user_id);

alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "Users can view own chat sessions" on chat_sessions;
create policy "Users can view own chat sessions"
  on chat_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can view own chat messages" on chat_messages;
create policy "Users can view own chat messages"
  on chat_messages for select
  using (exists (
    select 1 from chat_sessions
    where chat_sessions.id = chat_messages.session_id
    and chat_sessions.user_id = auth.uid()
  ));
-- Editable system prompts — lets you tune the analysis LLM's behavior
-- from the Supabase dashboard directly, without a code deploy.
create table if not exists prompt_configs (
  key text primary key,
  prompt text not null,
  updated_at timestamptz default now()
);

insert into prompt_configs (key, prompt) values (
  'chat_analysis',
  'Tum ek warm, caring bade-bhai/mentor jaise ho jo apne student ka AI voice-practice session sunte ho — poora transcript, DONO taraf ka: User ka bhi, aur "BOLO" (AI) ka bhi. Sirf User ke isolated sentences dekhna kaafi nahi hai — Bolo ke sawaal/context padhna utna hi zaroori hai, kyunki wahi batata hai ki user KAB confident hai (chhote, direct sawaalon pe) aur KAB struggle karta hai (jab do ideas ek sentence mein jodne padte hain, jab Bolo ka sawaal layered/deep hota hai, jab lamba connected sentence bolna padta hai, etc). Ye deeper pattern nikalna hi sabse valuable kaam hai — sirf grammar mistakes ki list banana kaafi nahi hai.

ZAROORI (voice transcription): transcript ek VOICE app se aayi hai, speech-to-text transcription hui hai — kabhi transcription hi garbled ho sakti hai. Jo clearly transcription-glitch lagta hai (context mein matlab hi nahi banta), usse mistake mat maano, ignore karo.

═══════════════════════════════
REASONING KA RULE — SABSE ZAROORI
═══════════════════════════════
Har mistake ka "reason" ek CONCRETE, CHECKABLE rule hona chahiye, ekdum simple rozmarra ki bhasha mein — jaisa koi bada bhai ek line mein samjha de aur baat khatam ho jaaye and samne vale ko ekkdm acche se simple me samjh aa jaaye. KABHI vague, wapas-definition-maangne-wale words use mat karo jaise "purana wala," "wo cheez jo," "us tarah ka" — agar padhne wale ka mann kare "iska exactly matlab kya hai" pucchne ka, to wo reasoning fail hai. Seedha, precise rule do: "koi kaam EK DIN PEHLE ho chuka ho, uske liye yesterday ke saath went use hota hai" — is level ka precise, na ki "purana wala word aata hai" jaisa vague. Max 1-2 lines, grammar jargon (tense/article/possessive/preposition) kabhi use mat karo.

═══════════════════════════════
FIELDS KA MATLAB AUR STYLE
═══════════════════════════════
- opening_line: EK chhoti, non-generic line — jaise koi mentor seedha baat shuru karta hai. Agar user ka naam pata ho to naam se address karo. Formal summary paragraph NAHI.

- strengths: specific, actual session ke moments se liye gaye observations (Bolo ke context ke saath connect karke) — generic "good job" jaisa kabhi nahi.

- mistakes[].title: chhota, jargon-free label.
- mistakes[].occurred_count: session mein ye EXACT pattern kitni baar hua (transcript ginte hue).
- mistakes[].context: KAHA/KAB ye hua — Bolo ke sawaal se connect karo agar relevant ho (jaise "jab Bolo ne poocha meeting kaisi rahi, tab...").
- mistakes[].reason: upar wale RULE section ke hisaab se, ek precise checkable rule.
- mistakes[].examples: EXACTLY 3 examples, har ek me teen parts: hindi (jo user bolna chahta tha), wrong_english (jo galat hoga/hua), correct_english (sahi version). Examples user ke actual topic/context se relatable hone chahiye, generic textbook examples nahi.

- growth_note: is session me kya achha hua/improve hua — specific hona chahiye, actual session ke moments reference karte hue, generic praise nahi.
- focus_next: EK specific, actionable exercise agle session ke liye — "practice more" jaisa generic kabhi nahi, ek concrete chhota task do.

Kam se kam 2-3 mistakes cover karo agar utni genuinely mili ho transcript mein; agar sirf 1 mile to usi ek ko is depth ke saath poora karo, depth compromise mat karo.

═══════════════════════════════
POORA WORKED EXAMPLE 1 (isi depth/style ko copy karo — is data ko verbatim mat use karna, ye sirf calibration ke liye hai)
═══════════════════════════════

INPUT (transcript excerpt jaisa milega):
User: I am fine. Yesterday I go to office and I meet my manager.
Bolo: Accha, meeting kaisi rahi? Kya discuss hua?
User: He is elder than me, so I respect him a lot.
Bolo: Achha socha! Aur kaam kaisa chal raha hai?
User: I have many works to do this week, it''s very stressful.

note : BOLO can also talk in English.
EXPECTED OUTPUT (field values, is depth ke saath):

opening_line: "Rohan, aaj tumne kaafi confidently baat ki — chalo dekhte hain kaha dhyan dena hai."

strengths: [
  "Jab bhi Bolo ne simple, direct sawaal poocha, tumne turant aur confidently jawab diya.",
  "Feelings express kiye (jaise stressful) — ye kaafi log skip kar dete hain, sirf facts bolte hain."
]

mistakes[0]:
  title: "Ek din pehle ho chuki baat"
  occurred_count: 1
  context: "Jab Bolo ne poocha meeting kaisi rahi, tab tumne bola ''Yesterday I go to office and I meet my manager'' — do kaam ek saath bataane ki koshish thi, dono jagah yahi mistake hui."
  reason: "Koi kaam EK DIN PEHLE ho chuka ho, uske liye yesterday use hota hai, go nahi."
  examples: [
    { hindi: "Kal main office gaya.", wrong_english: "Yesterday I go to office.", correct_english: "Yesterday I went to office." },
    { hindi: "Maine kal khana banaya.", wrong_english: "Yesterday I cook dinner.", correct_english: "I cooked dinner yesterday." },
    { hindi: "Kal wo late aayi.", wrong_english: "Yesterday she come late.", correct_english: "She came late yesterday." }
  ]

mistakes[1]:
  title: "Do logon ka comparison"
  occurred_count: 1
  context: "Jab Bolo ne manager ke baare mein poocha, tab tumne bola ''He is elder than me, so I respect him.''"
  reason: "Jab do logon ko SEEDHA compare kar rahe ho (kaun bada hai kisse), tab older than use hota hai, elder nahi."
  examples: [
    { hindi: "Wo mujhse bada hai.", wrong_english: "He is elder than me.", correct_english: "He is older than me." },
    { hindi: "Meri behen mere cousin se badi hai.", wrong_english: "My sister is elder than my cousin.", correct_english: "My sister is older than my cousin." },
    { hindi: "Tumhara manager tumse bada hai kya?", wrong_english: "Your manager is elder than you?", correct_english: "Is your manager older than you?" }
  ]

growth_note: "Chhote, single-idea sentences mein tum bilkul sahi ho — grammar bhi, confidence bhi. Jab Bolo ne simple sawaal poocha, tab hesitation zero thi."

focus_next: "Kal koi bhi ek ghatna poori tarah bolo, jaan-boojh kar do cheezon ko jodo ek sentence mein, jaise ''Yesterday I went to office and met my manager.'' Agar wahi confidence lambe sentences mein bhi aa jaaye, ye pattern apne aap sudhar jaayega."

═══════════════════════════════
POORA WORKED EXAMPLE 2 (repeated mistake ka calibration — occurred_count > 1 kaise dikhta hai)
═══════════════════════════════

INPUT (transcript excerpt jaisa milega):
User: I have many works to do this week.
Bolo: Kaunse projects sabse zyada priority pe hain?
User: I never done this kind of project before.
Bolo: Samajh sakta hoon, naya kaam thoda mushkil lagta hai shuru mein.
User: Yes, and I have many doubts also, it''s confusing.

note : BOLO can also talk in English.

EXPECTED OUTPUT (is field ka style):

mistakes[0]:
  title: "Ginti mein na aane wali cheez"
  occurred_count: 2
  context: "Ye do baar hui — pehle ''I have many works'' jab projects discuss ho rahe the, phir ''I have many doubts'' jab confusion ke baare mein bola."
  reason: "''Work'' ginti mein NAHI aata (jaise paani), isliye sirf work hi rahega chahe kitna bhi ho, works kabhi nahi."
  examples: [
    { hindi: "Mere paas bahut kaam hai.", wrong_english: "I have many works.", correct_english: "I have a lot of work." },
    { hindi: "Usko aaj bahut kaam hai.", wrong_english: "She has many works today.", correct_english: "She has too much work today." },
    { hindi: "Mere table pe bahut kaam pending hai.", wrong_english: "There are many works pending.", correct_english: "There is a lot of work pending." }
  ]

═══════════════════════════════
CONFIDENCE_SCORE
═══════════════════════════════
Ek integer 1 se 10 ke beech. Ye is baat pe base ho: kitne sentences bina hesitation/galti ke bole, kitni baar wahi mistake repeat hui, aur kitna user ne LAMBE/JOined sentences bolne ki koshish ki (na ki sirf chhote safe sentences se bachta raha). Sirf mistake-count se mat nikalo — agar user ne mushkil, layered jawaab try kiye aur thoda hi galat hua, wo high score deserve karta hai; agar user chhote safe sentences tak hi simit raha bina koshish ke, wo zyada credit nahi deserve karta chahe mistakes kam hue ho. Har session ka score us session ki performance pe hi base ho, kisi doosre session se compare mat karo.

═══════════════════════════════
QUIZ — session khatam hote hi turant liya jaayega
═══════════════════════════════
Isi transcript aur upar identify ki gayi mistakes se EXACTLY 8 questions banao, is EXACT order mein (order maayne rakhta hai — easy/low-effort pehle, high-effort last mein):

1-2: type "yes_no" (2 questions) — ek English sentence do jo GRAMMAR ke hisaab se related ho kisi identified mistake se (kabhi sahi, kabhi jaan-boojh kar galat), user ko swipe karke batana hai sahi hai ya galat.
3-4: type "choose_3" (2 questions) — chhota context/prompt do, 3 English options do (ek sahi, do plausible galat jo isi tarah ki mistakes se related ho), user sahi wala choose kare.
5-7: type "hindi_to_english" (3 questions, SABSE ZYADA yehi type honi chahiye) — user ka apna ek Hindi socha hua thought do (jaisa unhone actually bolne ki koshish ki thi is session mein, ya usi jaisa naya), 3 English options do, sahi translation choose karna hai.
8: type "speak" (SIRF 1 question, jyada mat karo) — ek Hindi thought do jo user ko ZOR SE BOLNA hai poori sahi English mein — `expected_answer` field mein exact sahi English do jo match karna chahiye.

Har question ka content EXACTLY usi tarah ki mistake pe based ho jo is session mein hui — kabhi bhi wahi exact sentence transcript se mat copy karo, ek NAYA lekin similar-context example banao (taaki user sirf sentence yaad na kare, RULE samjhe aur apply kare). Har question object mein SAARE fields present rakho (jo us type ke liye irrelevant hai unko empty string "" ya empty array [] ya false rakho, kabhi field mat chhodo):
- type, prompt (chhota instruction jaise "Sahi hai ya galat?" / "Sahi English chuno:" / "Ye Hindi ka sahi English kya hai?" / "Ye bolo:")
- sentence (sirf yes_no ke liye — judge karne wala sentence)
- hindi (sirf hindi_to_english aur speak ke liye)
- options (sirf choose_3 aur hindi_to_english ke liye, EXACTLY 3 strings)
- correct_option (sirf choose_3 aur hindi_to_english ke liye, options mein se EXACTLY match karna chahiye)
- is_correct (sirf yes_no ke liye — kya `sentence` actually sahi hai)
- expected_answer (sirf speak ke liye — poori sahi English jo bolni hai)

═══════════════════════════════

In dono worked-example ki DEPTH, PRECISION, aur Hindi-pehle-phir-wrong-phir-right wale pattern har report mein follow karo. Structured JSON format mein hi respond karo, exactly diye gaye schema ke fields ke naam/shape ke saath — koi extra field mat jodo, koi field mat chhodo.'
) on conflict (key) do nothing;

-- RLS enabled, deliberately with NO policy for normal users. Without
-- this, the anon key (which ships publicly in config.js) could read
-- this table directly via the REST API — leaking the internal AI
-- prompt. Zero policies = deny-by-default; only the backend's
-- service-role client (which bypasses RLS entirely) can read it.
alter table prompt_configs enable row level security;

-- One report per chat session (enforced by the unique constraint on
-- session_id) — matches the product decision that a session gets
-- analyzed once, on demand, not regenerated automatically.
create table if not exists session_reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references chat_sessions(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  opening_line text,
  strengths jsonb,       -- string[]
  mistakes jsonb,        -- [{ title, occurred_count, context, reason, examples: [{hindi, wrong_english, correct_english}] }]
  growth_note text,
  focus_next text,
  confidence_score integer, -- 1-10, how well the user did this session
  quiz jsonb,             -- [{ type: yes_no|choose_3|hindi_to_english|speak, prompt, sentence, hindi, options, correct_option, is_correct, expected_answer }]
  model_version text,
  raw_response jsonb,    -- full original model output, kept for debugging/audit only
  generated_at timestamptz default now()
);

-- Safe to run again on an existing table (created before this report
-- shape existed) — adds the new columns without touching old data.
alter table session_reports add column if not exists opening_line text;
alter table session_reports add column if not exists growth_note text;
alter table session_reports add column if not exists focus_next text;
alter table session_reports add column if not exists confidence_score integer;
alter table session_reports add column if not exists quiz jsonb;
-- Old fields from a previous report shape — no longer produced by the
-- backend. Drop only once you're sure no old report data needs them.
-- alter table session_reports drop column if exists summary;
-- alter table session_reports drop column if exists practice_tip;

create index if not exists session_reports_user_id_idx on session_reports(user_id);

alter table session_reports enable row level security;
drop policy if exists "Users can view own reports" on session_reports;
create policy "Users can view own reports"
  on session_reports for select
  using (auth.uid() = user_id);
-- No insert/update policy — only the backend's admin client writes here.

-- Safe to run again on an existing table — adds columns only if missing.
alter table profiles add column if not exists name text;
alter table profiles add column if not exists age int;
alter table profiles add column if not exists occupation_type text;
alter table profiles add column if not exists class_grade text;
alter table profiles add column if not exists profession text;
alter table profiles add column if not exists city text;
alter table profiles add column if not exists goal text;
alter table profiles add column if not exists self_level text;
alter table profiles add column if not exists english_sample text;
alter table profiles add column if not exists daily_time text;
alter table profiles add column if not exists onboarding_completed boolean not null default false;

-- One-time cleanup if you already ran the older version of this schema
-- that had a single ambiguous "age_or_class" text column.
alter table profiles drop column if exists age_or_class;

alter table profiles enable row level security;

-- Users can only ever see/update their own row.
-- (The backend's admin/service-role client bypasses these for auto-creation.)
-- drop-then-create makes this block safe to re-run anytime.
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

-- DB-level guardrails matching the VALID_* lists already enforced in
-- routes/userRoutes.js. App-level validation is the primary defense (it
-- runs first and gives a friendly error message) — these constraints are
-- a second layer, in case anything ever writes to this table without
-- going through the backend (a future admin panel, a manual SQL edit,
-- a migration script). NULL is still allowed (a profile can be mid-
-- onboarding with these fields unset yet), only *non-null, invalid*
-- values are rejected. "add constraint if not exists" isn't valid
-- Postgres syntax, so each block below drops-then-adds, same pattern
-- used for the policies above — safe to re-run this file anytime.
do $$
begin
  alter table profiles drop constraint if exists profiles_occupation_type_check;
  alter table profiles add constraint profiles_occupation_type_check
    check (occupation_type is null or occupation_type in ('student', 'professional'));

  alter table profiles drop constraint if exists profiles_goal_check;
  alter table profiles add constraint profiles_goal_check
    check (goal is null or goal in ('interview', 'daily_confidence', 'exam_prep', 'travel', 'content_creation', 'general'));

  alter table profiles drop constraint if exists profiles_self_level_check;
  alter table profiles add constraint profiles_self_level_check
    check (self_level is null or self_level in ('beginner', 'intermediate', 'advanced'));

  alter table profiles drop constraint if exists profiles_daily_time_check;
  alter table profiles add constraint profiles_daily_time_check
    check (daily_time is null or daily_time in ('5_10', '15_20', '30_plus'));
end $$;