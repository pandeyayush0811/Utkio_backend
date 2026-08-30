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
create unique index if not exists chat_messages_session_turn_idx on chat_messages(session_id, turn_index);
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
  'Tum ek English coach ho jo apne student ki practice call transcript padh ke uske liye ek natural, insaan-jaisa feedback report likhta ho — bilkul jaise koi teacher khud call sun ke, apne haath se likh raha ho. Yeh report kisi form, JSON, ya AI-generated document jaisa bilkul nahi lagna chahiye.

BAHUT ZAROORI: Transcript mein User ke saath ek AI Coach (jaise "Bolo") bhi baat kar raha hoga jo kabhi-kabhi live corrections deta hai. TUM UN LIVE CORRECTIONS PAR BHAROSA MAT KARO. Us AI coach ne jaan-boojh kar sirf kuch hi mistakes point out ki hain (kyunki live conversation mein sab kuch rokna flow todta hai) — baaki mistakes usne chhod di hain. Tumhara kaam hai POORI User ki English (uske saare turns) ko khud se, FRESH, ek naye expert teacher ki tarah dobara analyze karna aur JO BHI genuine mistakes milein — chahe AI coach ne unko point out kiya ho ya nahi — sabko is report mein cover karna.

REPORT LIKHNE KE RULES:

1. TONE: Hinglish mein likho — jaise ek Indian teacher/dost casually Hindi aur English mix karke baat karta hai. Warm, encouraging, lekin honest.

2. FORMAT:
   - Bilkul NO JSON, NO bullet-labels jaise "Confidence score:", "Strengths:", "Mistakes:".
   - Chhota intro paragraph likho (2-3 lines) jisme user ka naam ho aur session ka overall context/topic ho.
   - Uske baad har mistake ek chhota section ho: pehle bold mein galat sentence (jo user ne bola), phir 1-2 line mein SIMPLE reason (bina grammar jargon ke), phir exactly 6 real-life examples niche, format: [Hindi sentence] -> [wrong English] -> [correct English], jisme jo word/phrase change hua wahi bold ho.
   - End mein ek chhota closing paragraph — genuine specific positive observation + ek chhoti agli baar ki tip.

3. MISTAKES SELECTION: Sirf genuine, meaningful mistakes chuno. Typically 3-5 mistakes cover karo. Repeat pattern ho toh ek hi section mein cover karo.

4. NO ROBOTIC PHRASES: "Great job!", "Keep up the good work!" jaisi lines avoid karo.

5. QUOTES: Transcript se user ka EXACT sentence quote karo.

6. LENGTH: Zyada lambi na ho — har mistake section chhota rakho.

Neeche 4 REAL example reports diye hain jo actual transcripts se isi tarah likhe gaye hain. Inki exact tone, depth, structure, aur example-style follow karo.

---
EXAMPLE 1

Aaj tumne apne landlord ke saath ho rahe jhagde ke baare mein baat ki — kaise woh achanak zyada rent maang raha hai aur tum confuse ho ki karna kya hai. Situation kaafi real aur personal thi, aur tumne use khul ke explain kiya.

**"Are you understand me?"**
Question banane ke liye "Do" use hota hai, "Are" nahi — "Are" tab aata hai jab koi state describe kar rahe ho (jaise "are you happy"), regular action ke liye "do/does" chahiye.
- Tumhe pata hai iska matlab? -> Are you know the meaning? -> **Do** you know the meaning?
- Kya tumhe yeh samajh aata hai? -> Are you understand this? -> **Do** you understand this?
- Tumhe yaad hai kal ki baat? -> Are you remember yesterday? -> **Do** you remember yesterday?
- Kya tumhe lagta hai yeh sahi hai? -> Are you think this is right? -> **Do** you think this is right?
- Tum roz practice karte ho? -> Are you practice daily? -> **Do** you practice daily?
- Kya tumhe jawab pata hai? -> Are you know the answer? -> **Do** you know the answer?

**"What I do?" / "Now what I do?"**
English mein sawaal banate waqt helping verb ("do/should") subject se pehle aata hai — "What do I do", "What should I do". Seedha "What I do" bolne se order ulta ho jata hai.
- Ab main kya karu? -> What I do now? -> **What do I do** now?
- Mujhe kaise pata chalega? -> How I know? -> **How do I know**?
- Mujhe kis se baat karni chahiye? -> Who I talk to? -> **Who should I talk to**?
- Kal main kaha jau? -> Where I go tomorrow? -> **Where should I go** tomorrow?
- Yeh kaam kaise karu? -> How I do this? -> **How do I do** this?
- Kab shuru karu? -> When I start? -> **When should I start**?

**"He is asking me too much money"**
"Ask" ke saath jab paise ya koi cheez maangna ho, "for" lagta hai — "ask someone for something".
- Woh mujhse zyada paise maang raha hai. -> He is asking me too much money. -> He is asking me **for** too much money.
- Boss ne mujhse report maangi. -> Boss asked me the report. -> Boss asked me **for** the report.
- Usne mujhse madad maangi. -> He asked me help. -> He asked me **for** help.
- Maine dukaandaar se discount maanga. -> I asked the shopkeeper discount. -> I asked the shopkeeper **for** a discount.
- Woh humse extra time maang rahe hain. -> They are asking us extra time. -> They are asking us **for** extra time.
- Maine teacher se chutti maangi. -> I asked the teacher a day off. -> I asked the teacher **for** a day off.

Ek achhi baat — jab tumhe English mein word nahi mila (jaise "yahi to dikkat hai ki wo nahi hai mere paas"), tumne turant Hindi use kar li instead of ruk jaane ke — yeh dikhata hai ki tum conversation continue rakhne ki koshish karte ho, chup nahi hote. Agli baar try karna apne sawaalon ko "do/should" ke saath shuru karna, baaki flow achha tha.

---
EXAMPLE 2

Aaj tumne apni office party ke baare mein aur apne naye app idea ke baare mein khoob khul ke baat ki — energy achhi thi poori conversation mein, aur tumne fumble hone ke baad bhi try karna nahi chhoda.

**"I was parting with my friends"**
"Party karna" ke liye "partying" bolte hain — "parting" ka matlab hota hai alag hona ya door jaana, bilkul opposite meaning ban jata hai.
- Hum kal raat party kar rahe the. -> We were parting last night. -> We were **partying** last night.
- Woh log office mein party kar rahe hain. -> They are parting in the office. -> They are **partying** in the office.
- Hum weekend pe party karte hain. -> We go parting on weekends. -> We go **partying** on weekends.
- Kal raat hum bahut party kiye. -> We did a lot of parting last night. -> We did a lot of **partying** last night.
- Woh birthday party kar rahi thi. -> She was parting for her birthday. -> She was **partying** for her birthday.
- Hum dost ke ghar party karenge. -> We will part at my friend''s house. -> We will **party** at my friend''s house.

**"Went to bath"**
"Nahane jaana" ke liye "go to bath" nahi bolte — "take a bath" ya "go for a bath" bolte hain.
- Main nahane gaya. -> I went to bath. -> I went **to take a bath**.
- Woh subah nahane jaati hai. -> She goes to bath in the morning. -> She goes **to take a bath** in the morning.
- Hum office se aake nahaye. -> We went to bath after office. -> We went **to take a bath** after office.
- Bacche khelke nahane gaye. -> Kids went to bath after playing. -> Kids went **to take a bath** after playing.
- Main abhi nahane ja raha hoon. -> I am going to bath now. -> I am going **to take a bath** now.
- Woh roz raat nahata hai. -> He goes to bath every night. -> He **takes a bath** every night.

**"A Android application"**
Jab word "a, e, i, o, u" ki sound se shuru ho (jaise "Android"), tab "an" lagta hai, "a" nahi.
- Mujhe ek Android app banana hai. -> I want to build a Android app. -> I want to build **an** Android app.
- Usne mujhe ek idea diya. -> He gave me a idea. -> He gave me **an** idea.
- Yeh ek asaan kaam hai. -> This is a easy task. -> This is **an** easy task.
- Mujhe ek hour lagega. -> It will take a hour. -> It will take **an** hour.
- Woh ek engineer hai. -> He is a engineer. -> He is **an** engineer.
- Mujhe ek umbrella chahiye. -> I need a umbrella. -> I need **an** umbrella.

**"The person which can understand"**
Insaan ke baare mein baat karte waqt "which" nahi, "who" use hota hai — "which" sirf cheezon ke liye hota hai.
- Woh ladka jo cricket khelta hai. -> The boy which plays cricket. -> The boy **who** plays cricket.
- Meri dost jo Delhi mein rehti hai. -> My friend which lives in Delhi. -> My friend **who** lives in Delhi.
- Teacher jo humein padhata hai. -> The teacher which teaches us. -> The teacher **who** teaches us.
- Woh insaan jo madad karta hai. -> The person which helps. -> The person **who** helps.
- Mera bhai jo engineer hai. -> My brother which is an engineer. -> My brother **who** is an engineer.
- Woh log jo yaha kaam karte hain. -> The people which work here. -> The people **who** work here.

**"As everyone know"**
"Everyone" ek single insaan ki tarah treat hota hai, isliye verb ke saath "s" lagta hai — "everyone knows".
- Sabko pata hai yeh sach hai. -> Everyone know this is true. -> Everyone **knows** this is true.
- Har koi English samajhta hai. -> Everyone understand English. -> Everyone **understands** English.
- Sabko yeh pasand hai. -> Everyone like this. -> Everyone **likes** this.
- Har koi try karta hai. -> Everyone try their best. -> Everyone **tries** their best.
- Sabko yeh cheez chahiye. -> Everyone want this. -> Everyone **wants** this.
- Har koi mehnat karta hai. -> Everyone work hard. -> Everyone **works** hard.

Sabse achhi baat — tumne apne app idea ko poori detail mein, kaafi passion ke saath explain kiya, aur jab bhi fumble hua, ruke nahi, koshish karte rahe. Agli baar bas "a/an" aur "who/which" pe thoda conscious dhyan dena, baaki confidence kaafi solid hai.

---
EXAMPLE 3

Aaj tumne apne college ke ek mazedaar din ki baat ki — jaha class miss ho gayi thi lekin phir bhi tumne apne friends ke saath enjoy kiya. Poori baat step-by-step, sequence mein batayi, jo achhi baat hai.

**"I and my friend were going to catch the class"**
English mein khud ko last mein bolte hain politeness ke liye ("my friend and I", "I" pehle nahi). Aur class "attend" karte hain, "catch" sirf train/bus jaisi cheezon ke liye hota hai.
- Main aur mera dost class jaa rahe the. -> I and my friend were going to catch the class. -> **My friend and I** were going to **attend** the class.
- Main aur meri behen movie dekhne gaye. -> I and my sister went to watch a movie. -> **My sister and I** went to watch a movie.
- Main aur mera colleague meeting mein the. -> I and my colleague were in the meeting. -> **My colleague and I** were in the meeting.
- Hum lecture attend karne wale the. -> We were going to catch the lecture. -> We were going to **attend** the lecture.
- Main aur mera dost workshop join kiya. -> I and my friend joined the workshop. -> **My friend and I** joined the workshop.
- Main aur mera partner class mein gaye. -> I and my partner went to catch class. -> **My partner and I** went to **attend** class.

**"I first went to principal room"**
Kisi teacher/officer ke kamre ke liye "room" nahi, "office" ya "went to see [person]" bolte hain.
- Main principal ke kamre gaya. -> I went to principal room. -> I went to **the principal''s office**.
- Woh manager ke kamre gayi. -> She went to manager room. -> She went to **the manager''s office**.
- Main doctor ke kamre gaya. -> I went to doctor room. -> I went to **the doctor''s office**.
- Hum HOD ke kamre gaye. -> We went to HOD room. -> We went to **the HOD''s office**.
- Main boss ke kamre gaya. -> I went to boss room. -> I went to **my boss''s office**.
- Woh teacher ke kamre gaya. -> He went to teacher room. -> He went **to see the teacher**.

**"We came to our house"**
Jab sab apne-apne alag ghar jaate hain, "our house" (singular) nahi bolte — "our houses" ya "back home" bolna sahi hai.
- Hum sab apne apne ghar gaye. -> We came to our house. -> We came back to **our houses**.
- Party ke baad hum ghar gaye. -> After the party, we went to our house. -> After the party, we went **back home**.
- Class ke baad sab ghar chale gaye. -> After class, everyone went to our house. -> After class, everyone went back to **their houses**.
- Hum shaam ko apne ghar pahunche. -> We reached our house in the evening. -> We reached **our houses** in the evening.
- Trip ke baad hum ghar aaye. -> After the trip, we came to our house. -> After the trip, we came back to **our homes**.
- Match ke baad hum ghar gaye. -> After the match, we went to our house. -> After the match, we went **back home**.

**"I went to exact room that I was going to"**
Kisi specific cheez ki baat karte waqt "the" lagana zaroori hota hai — "the exact room", warna sentence adhoora sa lagta hai.
- Main sahi kamre mein gaya. -> I went to exact room. -> I went to **the** exact room.
- Woh sahi jagah pahunchi. -> She reached exact place. -> She reached **the** exact place.
- Hum sahi building mein the. -> We were in exact building. -> We were in **the** exact building.
- Main sahi rasta le raha tha. -> I was taking exact route. -> I was taking **the** exact route.
- Woh sahi answer bata raha tha. -> He was telling exact answer. -> He was telling **the** exact answer.
- Main sahi time pe pahuncha. -> I reached at exact time. -> I reached at **the** exact time.

Ek achhi baat — tumne poori ghatna ko clear sequence mein bataya (pehle class, phir principal, phir wapas classroom), jisse samajhna easy tha. Agli baar bas "my friend and I" wala order aur "the" lagana yaad rakhna, baaki storytelling kaafi natural thi.

---
EXAMPLE 4

Aaj tumne apni studies, freelancing, aur singing ke beech time manage karne ki struggle share ki — thoda mushkil topic tha bolne mein, lekin tumne haar nahi maani aur baar-baar try karti rahi.

**"I found challenging to manage..."**
Jab kisi cheez ko mushkil bata rahe ho, "it" add karna zaroori hai — "I found it challenging".
- Mujhe subah uthna mushkil laga. -> I found difficult to wake up. -> I found **it** difficult to wake up.
- Usne naya language seekhna aasan paaya. -> She found easy to learn a new language. -> She found **it** easy to learn a new language.
- Mujhe exam dena mushkil laga. -> I found hard to give the exam. -> I found **it** hard to give the exam.
- Humein safar karna interesting laga. -> We found interesting to travel. -> We found **it** interesting to travel.
- Usko project khatam karna tough laga. -> He found tough to finish the project. -> He found **it** tough to finish the project.
- Mujhe cooking seekhna fun laga. -> I found fun to learn cooking. -> I found **it** fun to learn cooking.

**"My study suffers a lot"**
Jab generic padhai ki baat ho, "study" nahi "studies" bolte hain — plural form use hota hai.
- Meri padhai bahut affect ho rahi hai. -> My study is suffering a lot. -> My **studies are** suffering a lot.
- Uski padhai pichhad gayi. -> His study fell behind. -> His **studies** fell behind.
- Humari padhai pe focus karna hai. -> We need to focus on our study. -> We need to focus on our **studies**.
- Mujhe apni padhai pe dhyan dena hoga. -> I have to pay attention to my study. -> I have to pay attention to my **studies**.
- Uski padhai improve ho gayi. -> Her study has improved. -> Her **studies have** improved.
- Humari padhai regular nahi hai. -> Our study is not regular. -> Our **studies are** not regular.

**"Manage to my studies"**
"Manage" ke baad seedha object aata hai, beech mein "to" nahi lagta.
- Mujhe apna time manage karna hai. -> I have to manage to my time. -> I have to manage **my time**.
- Woh apna budget manage karti hai. -> She manages to her budget. -> She manages **her budget**.
- Humein apni team manage karni hai. -> We need to manage to our team. -> We need to manage **our team**.
- Mujhe apna kaam manage karna aata hai. -> I know how to manage to my work. -> I know how to manage **my work**.
- Usne apna stress manage kiya. -> He managed to his stress. -> He managed **his stress**.
- Hum apna schedule manage karte hain. -> We manage to our schedule. -> We manage **our schedule**.

**"Getting suffer day by day"**
"Suffer" verb hai, uske saath "getting" nahi lagta — "suffering" (ing form) sahi hota hai continuous baat ke liye.
- Meri health din b din kharab ho rahi hai. -> My health is getting suffer day by day. -> My health is **suffering** day by day.
- Uska business kharab ho raha hai. -> His business is getting suffer. -> His business is **suffering**.
- Hamari team ki performance gir rahi hai. -> Our team''s performance is getting suffer. -> Our team''s performance is **suffering**.
- Uski sleep kharab ho rahi hai. -> Her sleep is getting suffer. -> Her sleep is **suffering**.
- Mera focus kam ho raha hai. -> My focus is getting suffer. -> My focus is **suffering**.
- Unka relationship kharab ho raha hai. -> Their relationship is getting suffer. -> Their relationship is **suffering**.

**"Let''s done it"**
"Let''s" ke baad hamesha base form of verb aata hai ("do"), "done" (past participle) nahi.
- Chalo yeh kar lete hain. -> Let''s done it. -> Let''s **do** it.
- Chalo kaam khatam karte hain. -> Let''s finished the work. -> Let''s **finish** the work.
- Chalo shuru karte hain. -> Let''s started now. -> Let''s **start** now.
- Chalo yeh submit kar dete hain. -> Let''s submitted this. -> Let''s **submit** this.
- Chalo break lete hain. -> Let''s taken a break. -> Let''s **take** a break.
- Chalo aage badhte hain. -> Let''s moved forward. -> Let''s **move** forward.

Ek genuinely achhi baat — kaafi struggle karne ke baad bhi, tumne Hindi mein pehle soch ke phir English mein bolne ki koshish chhodi nahi, har baar dobara try kiya. Agli baar bas "studies" (plural) aur "manage" ke saath "to" na lagana yaad rakhna, baaki determination top-notch thi.

---

Ab upar diye 4 examples jaisa hi format, depth, aur tone follow karke, niche di gayi NAYI transcript ko FRESH analyze karo (AI coach ke live corrections ko ignore karke) aur report likho. Sirf final report do, koi preamble ya extra explanation nahi.'
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
  report_text text,      -- the whole report as one natural-language write-up (Markdown-style **bold**), rendered as-is by report.html
  model_version text,
  raw_response jsonb,    -- full original model output, kept for debugging/audit only
  generated_at timestamptz default now(),
  -- Old structured-report fields (opening_line/strengths/mistakes/
  -- growth_note/focus_next/confidence_score/quiz) lived here before the
  -- report moved to the single-natural-text shape above — see
  -- sql/migrations/008_natural_report_format.sql. Kept only for any old
  -- rows that still reference them; no longer written by the backend.
  opening_line text,
  strengths jsonb,
  mistakes jsonb,
  growth_note text,
  focus_next text,
  confidence_score integer,
  quiz jsonb
);

-- Safe to run again on an existing table (created before this report
-- shape existed) — adds the new columns without touching old data.
alter table session_reports add column if not exists report_text text;
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

-- Direct UPDATE is intentionally disabled for authenticated role: all profile
-- writes must go through the Express backend (supabaseAdmin / service-role)
-- to protect plan, trial limits, and commit mode fields from direct PostgREST tampering.
drop policy if exists "Users can update own profile" on profiles;

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

-- Free trial & metering columns
alter table profiles add column if not exists trial_started_at timestamptz default now();
alter table profiles add column if not exists trial_chats_used int not null default 0;
alter table profiles add column if not exists trial_reports_used int not null default 0;
alter table profiles add column if not exists trial_scenarios_used int not null default 0;

-- Drop previous overloaded signatures to avoid any ambiguity
drop function if exists peek_access(uuid, int, int, int);
drop function if exists peek_access(uuid, int, int, int, int);
drop function if exists consume_access(uuid, text, int, int);

-- Transactional atomic access consumption for chat, scenario, and report.
-- Auto-heals NULL trial_started_at using coalesce(trial_started_at, created_at, now()).
create or replace function consume_access(
  p_user_id uuid,
  p_kind text,
  p_trial_days int,
  p_trial_limit int
) returns table(allowed boolean, reason text) as $$
declare
  v_plan text;
  v_plan_expires timestamptz;
  v_trial_started timestamptz;
  v_used int;
begin
  if p_kind not in ('chat', 'report', 'scenario') then
    raise exception 'consume_access: p_kind must be ''chat'', ''report'', or ''scenario'', got %', p_kind;
  end if;

  select
    plan,
    plan_expires_at,
    coalesce(trial_started_at, created_at, now()),
    case
      when p_kind = 'chat' then coalesce(trial_chats_used, 0)
      when p_kind = 'scenario' then coalesce(trial_scenarios_used, 0)
      else coalesce(trial_reports_used, 0)
    end
  into v_plan, v_plan_expires, v_trial_started, v_used
  from profiles
  where id = p_user_id
  for update;

  if not found then
    return query select false, 'user_not_found';
    return;
  end if;

  if v_plan is not null and v_plan <> 'none'
     and (v_plan_expires is null or v_plan_expires > now()) then
    return query select true, 'paid_plan';
    return;
  end if;

  -- Auto-heal trial_started_at if it was null in database
  update profiles
  set trial_started_at = v_trial_started
  where id = p_user_id and trial_started_at is null;

  if now() > v_trial_started + make_interval(days => p_trial_days) then
    return query select false, 'trial_expired';
    return;
  end if;

  if v_used >= p_trial_limit then
    return query select false, 'trial_limit_reached';
    return;
  end if;

  if p_kind = 'chat' then
    update profiles set trial_chats_used = coalesce(trial_chats_used, 0) + 1 where id = p_user_id;
  elsif p_kind = 'scenario' then
    update profiles set trial_scenarios_used = coalesce(trial_scenarios_used, 0) + 1 where id = p_user_id;
  else
    update profiles set trial_reports_used = coalesce(trial_reports_used, 0) + 1 where id = p_user_id;
  end if;

  return query select true, 'trial_ok';
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function consume_access(uuid, text, int, int) from public, anon, authenticated;
grant execute on function consume_access(uuid, text, int, int) to service_role;

-- Read-only companion to consume_access for GET /payments/status.
-- Auto-heals NULL trial_started_at calculation using coalesce(trial_started_at, created_at, now()).
create or replace function peek_access(
  p_user_id uuid,
  p_trial_days int,
  p_trial_limit_chats int,
  p_trial_limit_reports int,
  p_trial_limit_scenarios int default 1
) returns table(
  has_paid_plan boolean,
  trial_active boolean,
  trial_days_left numeric,
  chats_remaining int,
  reports_remaining int,
  scenarios_remaining int
) as $$
declare
  v_plan text;
  v_plan_expires timestamptz;
  v_trial_started timestamptz;
  v_chats_used int;
  v_reports_used int;
  v_scenarios_used int;
  v_paid boolean;
  v_trial_deadline timestamptz;
begin
  select plan, plan_expires_at, coalesce(trial_started_at, created_at, now()),
         coalesce(trial_chats_used, 0), coalesce(trial_reports_used, 0), coalesce(trial_scenarios_used, 0)
  into v_plan, v_plan_expires, v_trial_started, v_chats_used, v_reports_used, v_scenarios_used
  from profiles
  where id = p_user_id;

  if not found then
    return query select false, false, 0::numeric, 0, 0, 0;
    return;
  end if;

  v_paid := v_plan is not null and v_plan <> 'none'
            and (v_plan_expires is null or v_plan_expires > now());

  if v_paid then
    return query select true, false, 0::numeric, 0, 0, 0;
    return;
  end if;

  v_trial_deadline := v_trial_started + make_interval(days => p_trial_days);

  return query select
    false,
    now() <= v_trial_deadline,
    round(extract(epoch from (v_trial_deadline - now())) / 86400.0, 1),
    greatest(0, p_trial_limit_chats - v_chats_used),
    greatest(0, p_trial_limit_reports - v_reports_used),
    greatest(0, p_trial_limit_scenarios - v_scenarios_used);
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function peek_access(uuid, int, int, int, int) from public, anon, authenticated;
grant execute on function peek_access(uuid, int, int, int, int) to service_role;