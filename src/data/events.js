export const EVENT_DURATION_MS = 5 * 60 * 1000; // 5 minutes mandatory lock

export const events = [
  {
    id: "flash-1",
    round: 1,
    category: "📰 FLASH 1 — GLOBAL WIRE & MATERIAL BREAKTHROUGH",
    headline: "WOMPWOMPIA GOLD RESERVES DECLARED FABRICATED; MYSTERY MATERIAL 'LUMINUM-9' DISCOVERED",
    subheadline: "Financial markets react as auditors reveal massive gold reserve discrepancies, while labs confirm a synthetic alloy breakthrough.",
    duration: 300,
    content: `BREAKING WIRE — Wompwompia's central bank has admitted that over 80% of its reported gold reserves were forged tungsten bars. Gold-backed assets crashed 45% globally within hours.

Simultaneously, a consortium of researchers released findings on 'Luminum-9', an ultra-lightweight synthetic metal alloy with 10x the strength of titanium and zero thermal expansion. 

INDUSTRY IMPLICATIONS:
• Electronics & Automotive: Companies heavily invested in Luminum-9 R&D and specialized Production tooling expect massive efficiency gains.
• Food & Pharma: High initial packaging demand for lightweight distribution.
• Cash Reserves: High cash holding yields low returns during this speculative rally.`,
    affectedDepartments: ["Research", "Production", "Marketing"],
    flashMultipliers: {
      Pharma: { Production: 1.4, Marketing: 1.1, Logistics: 1.2, Research: 1.8, "Human Resources": 1.1, Cash: 0.9 },
      Food: { Production: 1.5, Marketing: 1.3, Logistics: 1.1, Research: 1.4, "Human Resources": 1.0, Cash: 0.9 },
      Electronics: { Production: 1.8, Marketing: 1.2, Logistics: 1.1, Research: 2.1, "Human Resources": 1.2, Cash: 0.8 },
      "Travel and Auto": { Production: 1.7, Marketing: 1.3, Logistics: 1.2, Research: 1.9, "Human Resources": 1.1, Cash: 0.8 },
      Education: { Production: 1.1, Marketing: 1.4, Logistics: 1.0, Research: 1.6, "Human Resources": 1.3, Cash: 0.9 }
    }
  },
  {
    id: "flash-2",
    round: 2,
    category: "📰 FLASH 2 — LOGISTICS & INFRASTRUCTURE CRISIS",
    headline: "MYSTERY TRUCKING FIRM 'YALEX' MONOPOLIZES FREIGHT CORRIDORS",
    subheadline: "Unprecedented toll hikes and exclusive highway rights trigger severe supply bottlenecks across regional trade hubs.",
    duration: 300,
    content: `NATIONAL DESK — A shadowy logistics conglomerate known as 'Yalex Highway Transit' has acquired exclusive operator contracts over 70% of interstate shipping routes. Freight rates have surged by 210% overnight.

Shipments of raw materials and finished goods are experiencing multi-week delays unless companies secure priority transit contracts.

INDUSTRY IMPLICATIONS:
• Logistics: Investments in internal fleet management, regional warehousing, and direct supply lines yield massive protection against price gouging.
• Production: High production without adequate logistics results in stranded inventory.
• Government Relief: The Department of Commerce has issued a mandatory $10,000 relief credit to all registered operating companies for Round 2.`,
    affectedDepartments: ["Logistics", "Production", "Human Resources"],
    flashMultipliers: {
      Pharma: { Production: 1.0, Marketing: 1.0, Logistics: 2.2, Research: 1.2, "Human Resources": 1.1, Cash: 0.9 },
      Food: { Production: 1.1, Marketing: 1.0, Logistics: 2.4, Research: 1.0, "Human Resources": 1.1, Cash: 0.9 },
      Electronics: { Production: 1.1, Marketing: 1.1, Logistics: 2.1, Research: 1.3, "Human Resources": 1.0, Cash: 0.9 },
      "Travel and Auto": { Production: 1.2, Marketing: 1.0, Logistics: 2.3, Research: 1.2, "Human Resources": 1.1, Cash: 0.9 },
      Education: { Production: 1.0, Marketing: 1.2, Logistics: 1.8, Research: 1.4, "Human Resources": 1.2, Cash: 0.9 }
    }
  },
  {
    id: "flash-3",
    round: 3,
    category: "📰 FLASH 3 — REPUTATION SCANDAL & COLD-STORAGE FAILURE",
    headline: "UNREFRIGERATED WAREHOUSE BLUNDER SPOILS REGIONAL STOCKS; VIRAL MARKETING SCANDAL ERUPTS",
    subheadline: "A grid failure combined with poor HR training causes massive stock degradation and widespread public backlash.",
    duration: 300,
    content: `INVESTIGATIVE WIRE — Over 400 metric tons of temperature-sensitive inventory spoiled across major industrial parks after backup generators failed to kick in.

To make matters worse, leaked internal memos revealed off-duty staff joking about quality controls, triggering an intense consumer boycott against negligent brands.

INDUSTRY IMPLICATIONS:
• Marketing & Public Relations: Brands with heavy Marketing and Crisis PR investments can turn the narrative around and gain market share from fallen rivals.
• Human Resources & Training: Staff compliance, quality assurance, and proper training prevent operational disasters.
• Food & Pharma: Heavily punished if Marketing & HR are neglected.`,
    affectedDepartments: ["Marketing", "Human Resources", "Research"],
    flashMultipliers: {
      Pharma: { Production: 0.8, Marketing: 2.2, Logistics: 1.1, Research: 1.5, "Human Resources": 2.0, Cash: 1.0 },
      Food: { Production: 0.7, Marketing: 2.5, Logistics: 1.0, Research: 1.3, "Human Resources": 2.1, Cash: 1.0 },
      Electronics: { Production: 1.1, Marketing: 2.0, Logistics: 1.2, Research: 1.6, "Human Resources": 1.7, Cash: 1.0 },
      "Travel and Auto": { Production: 1.0, Marketing: 2.1, Logistics: 1.1, Research: 1.5, "Human Resources": 1.8, Cash: 1.0 },
      Education: { Production: 1.0, Marketing: 2.3, Logistics: 1.0, Research: 1.6, "Human Resources": 1.9, Cash: 1.0 }
    }
  },
  {
    id: "flash-4",
    round: 4,
    category: "📰 FLASH 4 — MACROECONOMIC & AUTOMATION MANDATE",
    headline: "CENTRAL BANK ENACTS EMERGENCY RATE HIKE; GOVERNMENT MANDATES AUTOMATION TAX CREDITS",
    subheadline: "Final round macro shifts demand strict capital efficiency, heavy R&D automation, and balanced cash reserves.",
    duration: 300,
    content: `FINANCIAL TIMES — In a landmark policy shift, central bankers raised benchmark borrowing rates by 250 basis points to curb inflation. Meanwhile, federal regulators announced massive 100% tax write-offs for companies deploying next-generation automated robotics and AI infrastructure.

As the final market window closes, companies that balance high-efficiency R&D, automated Production, and disciplined Cash reserves will dominate sector rankings.

INDUSTRY IMPLICATIONS:
• Research & Production: Synergistic multiplier for automated technology and streamlined manufacturing.
• Cash: Higher interest rates reward healthy cash liquidity reserves (up to 40%).
• Over-concentration Penalty: Portfolios throwing 100% into a single bucket face severe diminishing returns.`,
    affectedDepartments: ["Research", "Production", "Cash"],
    flashMultipliers: {
      Pharma: { Production: 1.8, Marketing: 1.3, Logistics: 1.2, Research: 2.2, "Human Resources": 1.2, Cash: 1.5 },
      Food: { Production: 1.9, Marketing: 1.2, Logistics: 1.3, Research: 1.9, "Human Resources": 1.2, Cash: 1.5 },
      Electronics: { Production: 2.1, Marketing: 1.3, Logistics: 1.3, Research: 2.4, "Human Resources": 1.1, Cash: 1.5 },
      "Travel and Auto": { Production: 2.0, Marketing: 1.3, Logistics: 1.4, Research: 2.1, "Human Resources": 1.2, Cash: 1.5 },
      Education: { Production: 1.5, Marketing: 1.5, Logistics: 1.2, Research: 2.0, "Human Resources": 1.5, Cash: 1.5 }
    }
  }
];
