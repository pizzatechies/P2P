import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { invalidateIndex, nameScore, nameTokens, parseCsv, parseEuList, parseOfacList, parseOwnList, parseUkList, parseUnList, refreshSanctionsLists, screenName } from "../src/services/sanctions.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

type App = ReturnType<typeof makeApp>;

// Enough filler entries that a list looks real (a list of a handful of names is treated as broken).
const filler = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

function unXml(extra = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST dateGenerated="2026-11-18T00:00:00Z"><INDIVIDUALS>
<INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>FRANK KAKOLELE</FIRST_NAME><SECOND_NAME>BWAMBALE</SECOND_NAME><UN_LIST_TYPE>DRC</UN_LIST_TYPE>
  <REFERENCE_NUMBER>CDi.002</REFERENCE_NUMBER><NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
  <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>FRANK KAKORERE</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>BETWEEN</TYPE_OF_DATE><FROM_YEAR>1973</FROM_YEAR><TO_YEAR>1974</TO_YEAR></INDIVIDUAL_DATE_OF_BIRTH>
</INDIVIDUAL>
<INDIVIDUAL><DATAID>2</DATAID><FIRST_NAME>JOSEPH</FIRST_NAME><SECOND_NAME>OBUYA</SECOND_NAME><THIRD_NAME>K&apos;OTIENO</THIRD_NAME><UN_LIST_TYPE>TEST</UN_LIST_TYPE>
  <REFERENCE_NUMBER>TSi.001</REFERENCE_NUMBER><INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1980-02-01</DATE></INDIVIDUAL_DATE_OF_BIRTH>
</INDIVIDUAL>
${extra}
${filler(60, (i) => `<INDIVIDUAL><DATAID>${100 + i}</DATAID><FIRST_NAME>PERSON${i}</FIRST_NAME><SECOND_NAME>SURNAME${i}</SECOND_NAME><REFERENCE_NUMBER>FIi.${i}</REFERENCE_NUMBER><INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><YEAR>1960</YEAR></INDIVIDUAL_DATE_OF_BIRTH></INDIVIDUAL>`)}
</INDIVIDUALS><ENTITIES>
<ENTITY><DATAID>9</DATAID><FIRST_NAME>ALLIED DEMOCRATIC FORCES</FIRST_NAME><REFERENCE_NUMBER>CDe.001</REFERENCE_NUMBER><ENTITY_ALIAS><ALIAS_NAME>ADF</ALIAS_NAME></ENTITY_ALIAS></ENTITY>
</ENTITIES></CONSOLIDATED_LIST>`;
}

const sdnCsv = () =>
  [
    `306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. 'BNC'."`,
    `2676,"AL ZAWAHIRI, Dr. Ayman","individual","SDGT","Operational and Military Leader",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 19 Jun 1951; POB Giza, Egypt; nationality Egypt."`,
    filler(60, (i) => `${5000 + i},"FILLER${i}, Name${i}","individual","TEST",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 1950"`),
  ].join("\r\n") + "\r\n\x1a";
const altCsv = () => `2676,1,"aka","AL-ZAWAHIRI, Aiman Muhammad Rabi",-0- \r\n306,2,"aka","NATIONAL BANK OF CUBA",-0- \r\n`;

// The EU list (XML 1.1) and the UK Sanctions List, in their real shapes.
const euXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-11-20T16:51:00.798+01:00">
  <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.9001.11" logicalId="9001">
    <regulation regulationType="regulation" programme="RUS" logicalId="1"><publicationUrl>http://eur-lex.europa.eu/x</publicationUrl></regulation>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Oleksandr" middleName="" lastName="Petrenkov" wholeName="Oleksandr Petrenkov" strong="true" nameLanguage="" logicalId="2"></nameAlias>
    <nameAlias firstName="" middleName="" lastName="" wholeName="Олександр Петренков" strong="true" nameLanguage="UK" logicalId="3"></nameAlias>
    <nameAlias firstName="" middleName="" lastName="" wholeName="Alexander Petrenkov" strong="true" nameLanguage="EN" logicalId="4"></nameAlias>
    <citizenship region="" countryIso2Code="RU" countryDescription="RUSSIAN FEDERATION" logicalId="5"/>
    <birthdate circa="false" calendarType="GREGORIAN" city="" birthdate="1971-03-02" dayOfMonth="2" monthOfYear="3" year="1971" logicalId="6"></birthdate>
  </sanctionEntity>
  <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.9002.12" logicalId="9002">
    <regulation regulationType="regulation" programme="SYR" logicalId="7"></regulation>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="Levant Shipping &amp; Trading Company" strong="true" nameLanguage="" logicalId="8"></nameAlias>
  </sanctionEntity>
  ${filler(55, (i) => `<sanctionEntity euReferenceNumber="EU.F.${i}" logicalId="${20000 + i}"><subjectType code="person" classificationCode="P"/><nameAlias wholeName="Eufiller${i} Personname${i}" strong="true" nameLanguage=""></nameAlias><birthdate yearRangeFrom="1950" yearRangeTo="1952" logicalId="${30000 + i}"></birthdate></sanctionEntity>`)}
</export>`;

const ukXml = () => `<?xml version="1.0" encoding="utf-8"?>
<Designations xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <DateGenerated>20/11/2026</DateGenerated>
  <Designation>
    <UniqueID>GHA0001</UniqueID>
    <Names>
      <Name><Name1>Kwabena</Name1><Name2>Owusu</Name2><Name6>DARKWAH</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name1>Kobby</Name1><Name6>DARKWA</Name6><NameType>Alias</NameType><AliasStrength>Good quality a.k.a</AliasStrength></Name>
    </Names>
    <RegimeName>The Global Anti-Corruption Sanctions Regulations 2021</RegimeName>
    <IndividualEntityShip>Individual</IndividualEntityShip>
    <IndividualDetails><Individual><DOBs><DOB>dd/mm/1966</DOB><DOB>14/07/1967</DOB></DOBs><Nationalities><Nationality>Ghana</Nationality></Nationalities></Individual></IndividualDetails>
  </Designation>
  <Designation>
    <UniqueID>RUS9999</UniqueID>
    <Names><Name><Name6>OCEAN STAR</Name6><NameType>Primary Name</NameType></Name></Names>
    <IndividualEntityShip>Ship</IndividualEntityShip>
  </Designation>
  ${filler(55, (i) => `<Designation><UniqueID>FIL${i}</UniqueID><Names><Name><Name1>Ukfiller${i}</Name1><Name6>SURNAME${i}</Name6><NameType>Primary Name</NameType></Name></Names><IndividualEntityShip>Individual</IndividualEntityShip></Designation>`)}
</Designations>`;

async function listsStub(un = unXml()) {
  const state = { un };
  const s = await stub((req) => {
    if (req.route === "/un.xml") return { text: state.un };
    if (req.route === "/sdn.csv") return { text: sdnCsv() };
    if (req.route === "/alt.csv") return { text: altCsv() };
    if (req.route === "/eu.xml") return { text: euXml() };
    if (req.route === "/uk.xml") return { text: ukXml() };
    return undefined;
  });
  return {
    ...s,
    state,
    env: { SANCTIONS_UN_URL: `${s.url}/un.xml`, SANCTIONS_OFAC_SDN_URL: `${s.url}/sdn.csv`, SANCTIONS_OFAC_ALT_URL: `${s.url}/alt.csv`, SANCTIONS_EU_URL: `${s.url}/eu.xml`, SANCTIONS_UK_URL: `${s.url}/uk.xml` },
  };
}

async function makeAdmin({ app, ctx }: App) {
  const { agent, user } = await signup(app, "admin");
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

const jpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, fill)]);
const upload = (agent: ReturnType<typeof request.agent>, kind: string) => agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());

async function submitIdentity(agent: ReturnType<typeof request.agent>, legalName: string, dateOfBirth: string) {
  const A = api(agent);
  const saved = await A.put("/api/account/verification/1", {
    legalName,
    dateOfBirth,
    nationality: "KE",
    phone: "+254 712 000 000",
    address: { line1: "1 Moi Avenue", city: "Nairobi", country: "KE" },
    idType: "passport",
    idNumber: "AK0000001",
    idCountry: "KE",
    idExpiry: "2032-01-01",
  });
  expect(saved.status).toBe(200);
  expect((await upload(agent, "id_front")).status).toBe(201);
  expect((await upload(agent, "selfie")).status).toBe(201);
  return A.post("/api/account/verification/1/submit");
}

describe("sanctions lists", () => {
  it("parses the UN XML and OFAC CSV formats", () => {
    const un = parseUnList(unXml());
    const frank = un.find((e) => e.ref === "CDi.002")!;
    expect(frank).toMatchObject({ kind: "individual", name: "FRANK KAKOLELE BWAMBALE", aliases: ["FRANK KAKORERE"], birthYears: [1973, 1974], countries: ["Democratic Republic of the Congo"] });
    expect(un.find((e) => e.ref === "TSi.001")).toMatchObject({ name: "JOSEPH OBUYA K'OTIENO", birthYears: [1980] });
    expect(un.find((e) => e.ref === "CDe.001")).toMatchObject({ kind: "entity", aliases: ["ADF"] });
    const ofac = parseOfacList(sdnCsv(), altCsv());
    expect(ofac.find((e) => e.ref === "2676")).toMatchObject({ kind: "individual", birthYears: [1951], countries: ["Egypt"], aliases: ["AL-ZAWAHIRI, Aiman Muhammad Rabi"] });
    expect(ofac.find((e) => e.ref === "306")).toMatchObject({ kind: "entity", programs: "CUBA" });
    expect(parseCsv('1,"a, ""b""",c\r\n')).toEqual([["1", 'a, "b"', "c"]]);
  });

  it("matches names regardless of order, accents and small spelling differences", () => {
    expect(nameTokens("Dr. Ayman AL-ZAWAHIRI")).toEqual(["ayman", "al", "zawahiri"]);
    expect(nameScore(nameTokens("Zawahiri, Ayman al"), nameTokens("AL ZAWAHIRI, Dr. Ayman"))).toBe(1);
    expect(nameScore(nameTokens("Érik Badegé"), nameTokens("ERIC BADEGE"))).toBeGreaterThan(0.86);
    expect(nameScore(nameTokens("Jane Mwangi"), nameTokens("John Mwangi"))).toBeLessThan(0.86);
  });

  it("downloads both lists, screens by name and year of birth, and keeps a good copy when a download looks broken", async () => {
    const lists = await listsStub();
    const env = makeApp(lists.env);
    const admin = await makeAdmin(env);
    const r = await admin.A.post("/api/admin/sanctions/refresh");
    expect(r.body.results).toEqual([
      { list: "un", ok: true, entries: 63 },
      { list: "ofac", ok: true, entries: 62 },
    ]);
    expect(screenName(env.ctx, "Kakorere Frank").map((m) => m.ref)).toEqual(["CDi.002"]);
    expect(screenName(env.ctx, "Frank Kakolele Bwambale", { birthYear: 1990 })).toEqual([]); // born years apart: someone else
    expect(screenName(env.ctx, "Frank Kakolele Bwambale", { birthYear: 1974 })[0].score).toBe(1);
    expect(screenName(env.ctx, "National Bank of Cuba")).toEqual([]); // entities only when asked
    expect(screenName(env.ctx, "National Bank of Cuba", { kinds: ["individual", "entity"] })[0].ref).toBe("306");
    expect(screenName(env.ctx, "ADF", { kinds: ["entity"] })[0].ref).toBe("CDe.001");
    expect(screenName(env.ctx, "ADFX", { kinds: ["entity"] })).toEqual([]);

    // A broken download (almost empty) doesn't wipe the list.
    lists.state.un = "<CONSOLIDATED_LIST></CONSOLIDATED_LIST>";
    const again = await refreshSanctionsLists(env.ctx);
    expect(again.results[0]).toMatchObject({ list: "un", ok: false });
    const status = (await admin.A.get("/api/admin/sanctions")).body;
    expect(status.lists[0]).toMatchObject({ list: "un", entries: 63 });
    expect(status.lists[0].error).toMatch(/keeping the previous copy/);

    const manual = await admin.A.post("/api/admin/sanctions/check", { name: "Ayman al Zawahiri", birthYear: 1951 });
    expect(manual.body.matches[0]).toMatchObject({ list: "ofac", ref: "2676" });
    const audited = env.ctx.db.prepare("SELECT details FROM audit_events WHERE action = 'sanctions.manual_check'").get() as { details: string };
    expect(audited.details).not.toMatch(/Zawahiri/i);
  });
});

describe("screening customers", () => {
  it("flags a listed person at identity check: no auto-approval, no payments until an admin clears it", async () => {
    const lists = await listsStub();
    const env = makeApp({ ...lists.env, KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    await admin.A.post("/api/admin/sanctions/refresh");
    const friend = await signup(env.app, "friend");
    const F = api(friend.agent);
    await F.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });

    const person = await signup(env.app, "jo");
    const P = api(person.agent);
    await P.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const submitted = await submitIdentity(person.agent, "Joseph Obuya K'Otieno", "1980-02-01");
    expect(submitted.status).toBe(200);
    // Auto-approval is skipped for a possible match.
    expect(submitted.body.identity.submission.status).toBe("submitted");

    const alerts = (await admin.A.get("/api/admin/compliance")).body.alerts;
    expect(alerts).toEqual([expect.objectContaining({ rule: "sanctions_match", severity: "high", label: "Possible sanctions list match" })]);
    expect(alerts[0].summary).toMatch(/TSi\.001/);

    // Frozen both ways, with a message that doesn't tip them off.
    const send = await P.post("/api/payments/send", { to: friend.user.handle, amount: "5", currency: "USD" });
    expect(send.status).toBe(403);
    expect(send.body.error.message).toMatch(/being reviewed/);
    expect(send.body.error.message).not.toMatch(/sanction/i);
    expect((await F.post("/api/payments/send", { to: person.user.handle, amount: "5", currency: "USD" })).body.error.message).toMatch(/can't receive payments/);
    expect((await P.post("/api/payments/withdrawals", { rail: "sandbox", amount: "5", currency: "USD", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } })).status).toBe(403);

    // A false positive, cleared by a person: everything works again.
    await admin.A.post(`/api/admin/compliance/${alerts[0].id}`, { action: "clear", note: "Different person: checked passport and photo" });
    expect((await P.post("/api/payments/send", { to: friend.user.handle, amount: "5", currency: "USD" })).status).toBe(201);
    // Re-screening never reopens a cleared match.
    await refreshSanctionsLists(env.ctx);
    expect((await admin.A.get("/api/admin/compliance")).body.alerts).toEqual([]);
  });

  it("screens names at sign-up, payout recipients, and existing customers when the lists change", async () => {
    const lists = await listsStub();
    const env = makeApp({ ...lists.env, PAYOUT_REVIEW: "false" });
    const admin = await makeAdmin(env);
    await admin.A.post("/api/admin/sanctions/refresh");

    // Sign-up with a listed name.
    const { agent: fa, user: fu } = await request.agent(env.app).post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "fk@example.com", handle: "fkb", displayName: "Frank Kakorere", password: "correct-horse-42" }).then((r) => ({ agent: r, user: r.body.user }));
    expect(fa.status).toBe(201);
    const signupAlert = env.ctx.db.prepare("SELECT rule FROM compliance_alerts WHERE user_id = ?").get(fu.id) as { rule: string };
    expect(signupAlert.rule).toBe("sanctions_match");

    // A payout to a listed company is held for review, even with payout review switched off.
    const c = await signup(env.app, "exporter");
    env.ctx.db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString(), c.user.id);
    const C = api(c.agent);
    await C.post("/api/payments/deposits", { rail: "sandbox", amount: "50", currency: "USD" });
    const w = await C.post("/api/payments/withdrawals", { rail: "sandbox", amount: "20", currency: "USD", destination: { type: "bank_account", name: "Banco Nacional de Cuba", accountNumber: "99887766" } });
    expect(w.body.transfer).toMatchObject({ status: "pending", review: "required" });
    const queue = (await admin.A.get("/api/admin/payouts")).body.payouts;
    expect(queue[0].reasons[0]).toMatch(/sanctions list/);

    // Someone added to a list later is caught when the lists refresh.
    const late = await signup(env.app, "later");
    env.ctx.db.prepare("UPDATE users SET display_name = 'Baraka Mwakilema' WHERE id = ?").run(late.user.id);
    await refreshSanctionsLists(env.ctx);
    const before = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM compliance_alerts WHERE user_id = ?").get(late.user.id) as { n: number };
    expect(before.n).toBe(0);
    lists.state.un = unXml(`<INDIVIDUAL><DATAID>77</DATAID><FIRST_NAME>BARAKA</FIRST_NAME><SECOND_NAME>MWAKILEMA</SECOND_NAME><REFERENCE_NUMBER>TSi.077</REFERENCE_NUMBER></INDIVIDUAL>`);
    await refreshSanctionsLists(env.ctx);
    const after = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM compliance_alerts WHERE user_id = ? AND rule = 'sanctions_match'").get(late.user.id) as { n: number };
    expect(after.n).toBe(1);

    // Every screening leaves evidence, without the screened name.
    const evidence = env.ctx.db.prepare("SELECT subject, result, matches FROM sanctions_checks WHERE user_id = ?").all(c.user.id) as { subject: string; result: string; matches: string }[];
    expect(evidence.map((e) => `${e.subject}:${e.result}`)).toEqual(expect.arrayContaining(["display_name:clear", "payee:possible_match"]));
    expect(JSON.stringify(evidence)).not.toMatch(/Banco/i);

    const checklist = (await admin.A.get("/api/admin/security")).body.checks.find((x: { id: string }) => x.id === "sanctions");
    expect(checklist.status).toBe("pass");
  });
});

describe("EU, UK and your own list", () => {
  it("reads the EU and UK files: Latin-script names and aliases, years of birth, countries; ships skipped", () => {
    const eu = parseEuList(euXml());
    expect(eu).toHaveLength(57);
    expect(eu[0]).toMatchObject({ list: "eu", ref: "EU.9001.11", kind: "individual", name: "Oleksandr Petrenkov", aliases: ["Alexander Petrenkov"], birthYears: [1971], programs: "RUS", countries: ["RUSSIAN FEDERATION"] });
    expect(eu[1]).toMatchObject({ kind: "entity", name: "Levant Shipping & Trading Company", programs: "SYR" });
    expect(eu[2].birthYears).toEqual([1950, 1951, 1952]);
    const uk = parseUkList(ukXml());
    expect(uk).toHaveLength(56);
    expect(uk[0]).toMatchObject({ list: "uk", ref: "GHA0001", kind: "individual", name: "Kwabena Owusu DARKWAH", aliases: ["Kobby DARKWA"], birthYears: [1966, 1967], countries: ["Ghana"] });
    expect(uk.some((e) => e.ref === "RUS9999")).toBe(false);
  });

  it("downloads all four lists, screens against each, and stops using a list that's switched off", async () => {
    const lists = await listsStub();
    const env = makeApp({ ...lists.env, SANCTIONS_LISTS: "un,ofac,eu,uk" });
    const admin = await makeAdmin(env);
    const r = await admin.A.post("/api/admin/sanctions/refresh");
    expect(r.body.results.map((x: { list: string; ok: boolean; entries: number }) => `${x.list}:${x.ok}:${x.entries}`)).toEqual(["un:true:63", "ofac:true:62", "eu:true:57", "uk:true:56"]);
    expect(screenName(env.ctx, "Alexander Petrenkov", { birthYear: 1971 })[0]).toMatchObject({ list: "eu", ref: "EU.9001.11", listName: "EU Consolidated Financial Sanctions List" });
    expect(screenName(env.ctx, "Kobby Darkwa", { birthYear: 1967 })[0]).toMatchObject({ list: "uk", ref: "GHA0001" });
    expect(screenName(env.ctx, "Levant Shipping and Trading", { kinds: ["entity"] })[0].ref).toBe("EU.9002.12");
    const checklist = (await admin.A.get("/api/admin/security")).body.checks.find((x: { id: string }) => x.id === "sanctions");
    expect(checklist.status).toBe("pass");
    expect(checklist.detail).toMatch(/UK Sanctions List: 56 entries/);

    env.ctx.config.SANCTIONS_LISTS = ["un", "ofac"];
    invalidateIndex(env.ctx);
    expect(screenName(env.ctx, "Kobby Darkwa", { birthYear: 1967 })).toEqual([]);
    expect((await admin.A.get("/api/admin/sanctions")).body.lists.map((l: { list: string }) => l.list)).toEqual(["un", "ofac"]);
  });

  it("takes your own list as CSV, screens existing customers against it, and removes it", async () => {
    expect(() => parseOwnList("surname,born\nX,1970")).toThrow(/"name" column/);
    const own = parseOwnList('\uFEFFName,Type,Aliases,Born,Reference,Programme,Country\n"Chileshe Mwansa Banda",individual,"C. M. Banda; Chileshe Banda",12/03/1975,ZM-001,National designation,Zambia\nKafue Gem Traders,company,,,,"Local list",\n,,,,,\n');
    expect(own).toEqual([
      expect.objectContaining({ list: "own", ref: "ZM-001", kind: "individual", name: "Chileshe Mwansa Banda", aliases: ["C. M. Banda", "Chileshe Banda"], birthYears: [1975], programs: "National designation", countries: ["Zambia"] }),
      expect.objectContaining({ ref: "row-3", kind: "entity", name: "Kafue Gem Traders" }),
    ]);

    const env = makeApp({ SANCTIONS_LISTS: "" });
    const admin = await makeAdmin(env);
    const person = await signup(env.app, "cb");
    env.ctx.db.prepare("UPDATE users SET display_name = 'Chileshe Banda' WHERE id = ?").run(person.user.id);

    const bad = await admin.A.put("/api/admin/sanctions/own-list", { csv: "who\nnobody" });
    expect(bad.status).toBe(400);
    const up = await admin.A.put("/api/admin/sanctions/own-list", { csv: "name,type,aliases\nChileshe Mwansa Banda,individual,Chileshe Banda\nKafue Gem Traders,entity,\n" });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ entries: 2, rescreened: { matches: 1 } });
    expect(up.body.lists).toEqual([expect.objectContaining({ list: "own", downloaded: false, name: "Your own list", entries: 2 })]);
    const alert = env.ctx.db.prepare("SELECT rule, summary FROM compliance_alerts WHERE user_id = ?").get(person.user.id) as { rule: string; summary: string };
    expect(alert.rule).toBe("sanctions_match");
    expect(alert.summary).toMatch(/Your own list/);
    // A payout to a company on your list is caught like any other.
    expect(screenName(env.ctx, "Kafue Gem Traders", { kinds: ["individual", "entity"] })[0].list).toBe("own");

    expect((await admin.A.del("/api/admin/sanctions/own-list")).body.lists).toEqual([]);
    expect(screenName(env.ctx, "Chileshe Mwansa Banda")).toEqual([]);
    const actions = (env.ctx.db.prepare("SELECT action, details FROM audit_events WHERE action LIKE 'sanctions.own_list%' ORDER BY id").all() as { action: string; details: string }[]).map((a) => a.action);
    expect(actions).toEqual(["sanctions.own_list_uploaded", "sanctions.own_list_removed"]);
  });
});
