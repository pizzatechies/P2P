import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";
import { CtaBand, Section, SectionHead, usePageTitle } from "./common";

export function AboutPage() {
  usePageTitle("About");
  return (
    <>
      <section className="page-hero">
        <div className="site-container about-hero">
          <Logo size={88} />
          <div>
            <span className="eyebrow">About Aurex</span>
            <h1>The gold standard for <span className="gold-text">everyday money.</span></h1>
            <p className="lead">Aurex brings together the three things people increasingly do with money online (paying each other, getting answers, and investing) in one calm, trustworthy place.</p>
          </div>
        </div>
      </section>

      <Section>
        <div className="split">
          <SectionHead eyebrow="The name" title="Aurum + exchange" lead={<>Aurum is Latin for gold, the oldest store of trust in money. Exchange is what Aurex is for: exchanging money between people, ideas with AI, and value in the markets. The mark is a gold “A” whose crossbar is a two-way arrow, with a spark for the intelligence inside.</>} />
          <div className="name-card" aria-hidden="true">
            <div><span className="gold-text big">Aur</span><span className="faint">um · gold</span></div>
            <div className="plus">+</div>
            <div><span className="big">ex</span><span className="faint">change</span></div>
          </div>
        </div>
      </Section>

      <Section tone="warm">
        <SectionHead center eyebrow="What we believe" title="Principles behind every screen" />
        <div className="mini-grid">
          {[
            ["Every cent accounted for", "Money is recorded with the rigour of a bank ledger, not a spreadsheet."],
            ["You stay in control", "AI suggests, explains and sizes, but the decision is always yours."],
            ["Open to every AI", "Use the best model for each job instead of being locked into one."],
            ["Built for everyone", "From dollars to cedis and kwacha, Aurex is designed to work wherever you are."],
          ].map(([t, d]) => (
            <div key={t} className="mini">
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHead center title="Where to next?" />
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <Link className="btn secondary lg" to="/features">Explore features</Link>
          <Link className="btn secondary lg" to="/pricing">See pricing</Link>
          <Link className="btn secondary lg" to="/security">Security</Link>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
