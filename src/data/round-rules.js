const common = [
  "R&D & Innovation",
  "Marketing & Sales",
  "Supply Chain & Logistics",
  "Technology & Digitalization",
  "Workforce & Talent"
];

export const parametersByIndustry = {
  Food: [...common, "Procurement & Sourcing", "Production & Manufacturing", "Quality Control & Food Safety", "Demand & Inventory Management", "Product & Revenue Management"],
  Electronics: [...common, "Semiconductor & Chip Technology", "Component Manufacturing", "Memory & Storage", "Device Assembly", "Advanced Materials & Thermal Systems"],
  "Travel and Auto": [...common, "Vehicle Manufacturing", "Energy & Propulsion", "Vehicle Technology", "Dealership & Distribution", "Tourism & Aviation"],
  Pharma: [...common, "Clinical Trials", "Drug Manufacturing", "Quality Control & Compliance", "Hospital & Care Network", "Medical Devices & Digital Care"],
  Education: [...common, "Faculty Development", "Curriculum & Content", "Industry Partnerships", "Student Services & Admissions", "Assessment & Certification"]
};

// These are payout multipliers from the supplied Multipliers.pdf, keyed by flash and industry.
// Keep this configuration in calculation code; player-facing renderers never print these values.
const ranks = {
  Food: [
    ["Production & Manufacturing", "Supply Chain & Logistics", "R&D & Innovation", "Quality Control & Food Safety", "Technology & Digitalization", "Demand & Inventory Management", "Product & Revenue Management", "Procurement & Sourcing", "Marketing & Sales", "Workforce & Talent"],
    ["Supply Chain & Logistics", "Demand & Inventory Management", "Quality Control & Food Safety", "Production & Manufacturing", "Marketing & Sales", "Technology & Digitalization", "Procurement & Sourcing", "R&D & Innovation", "Product & Revenue Management", "Workforce & Talent"],
    ["Demand & Inventory Management", "Quality Control & Food Safety", "Marketing & Sales", "Supply Chain & Logistics", "Procurement & Sourcing", "Production & Manufacturing", "Product & Revenue Management", "R&D & Innovation", "Technology & Digitalization", "Workforce & Talent"],
    ["Procurement & Sourcing", "Product & Revenue Management", "Production & Manufacturing", "Technology & Digitalization", "Demand & Inventory Management", "Marketing & Sales", "Quality Control & Food Safety", "R&D & Innovation", "Workforce & Talent", "Supply Chain & Logistics"]
  ],
  Electronics: [
    ["Memory & Storage", "Advanced Materials & Thermal Systems", "R&D & Innovation", "Semiconductor & Chip Technology", "Technology & Digitalization", "Component Manufacturing", "Device Assembly", "Workforce & Talent", "Marketing & Sales", "Supply Chain & Logistics"],
    ["Technology & Digitalization", "Semiconductor & Chip Technology", "Advanced Materials & Thermal Systems", "Memory & Storage", "R&D & Innovation", "Workforce & Talent", "Marketing & Sales", "Supply Chain & Logistics", "Device Assembly", "Component Manufacturing"],
    ["R&D & Innovation", "Device Assembly", "Marketing & Sales", "Component Manufacturing", "Supply Chain & Logistics", "Semiconductor & Chip Technology", "Memory & Storage", "Technology & Digitalization", "Workforce & Talent", "Advanced Materials & Thermal Systems"],
    ["Semiconductor & Chip Technology", "R&D & Innovation", "Device Assembly", "Memory & Storage", "Technology & Digitalization", "Marketing & Sales", "Component Manufacturing", "Advanced Materials & Thermal Systems", "Workforce & Talent", "Supply Chain & Logistics"]
  ],
  Education: [
    ["R&D & Innovation", "Curriculum & Content", "Technology & Digitalization", "Industry Partnerships", "Workforce & Talent", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Assessment & Certification", "Marketing & Sales"],
    ["Curriculum & Content", "Industry Partnerships", "Assessment & Certification", "R&D & Innovation", "Workforce & Talent", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Marketing & Sales", "Technology & Digitalization"],
    ["R&D & Innovation", "Marketing & Sales", "Technology & Digitalization", "Industry Partnerships", "Curriculum & Content", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Workforce & Talent", "Assessment & Certification"],
    ["Curriculum & Content", "Assessment & Certification", "Student Services & Admissions", "R&D & Innovation", "Technology & Digitalization", "Faculty Development", "Marketing & Sales", "Industry Partnerships", "Workforce & Talent", "Supply Chain & Logistics"]
  ],
  Pharma: [
    ["R&D & Innovation", "Medical Devices & Digital Care", "Quality Control & Compliance", "Marketing & Sales", "Clinical Trials", "Drug Manufacturing", "Hospital & Care Network", "Supply Chain & Logistics", "Technology & Digitalization", "Workforce & Talent"],
    ["Supply Chain & Logistics", "Quality Control & Compliance", "Hospital & Care Network", "Technology & Digitalization", "Drug Manufacturing", "Clinical Trials", "Marketing & Sales", "Medical Devices & Digital Care", "R&D & Innovation", "Workforce & Talent"],
    ["Quality Control & Compliance", "Drug Manufacturing", "Marketing & Sales", "Supply Chain & Logistics", "Hospital & Care Network", "Technology & Digitalization", "Clinical Trials", "R&D & Innovation", "Medical Devices & Digital Care", "Workforce & Talent"],
    ["Drug Manufacturing", "R&D & Innovation", "Hospital & Care Network", "Quality Control & Compliance", "Technology & Digitalization", "Marketing & Sales", "Medical Devices & Digital Care", "Clinical Trials", "Workforce & Talent", "Supply Chain & Logistics"]
  ],
  "Travel and Auto": [
    ["Energy & Propulsion", "Vehicle Manufacturing", "R&D & Innovation", "Vehicle Technology", "Supply Chain & Logistics", "Technology & Digitalization", "Dealership & Distribution", "Tourism & Aviation", "Marketing & Sales", "Workforce & Talent"],
    ["Supply Chain & Logistics", "Dealership & Distribution", "Vehicle Manufacturing", "Technology & Digitalization", "Vehicle Technology", "Workforce & Talent", "Marketing & Sales", "R&D & Innovation", "Energy & Propulsion", "Tourism & Aviation"],
    ["Marketing & Sales", "Dealership & Distribution", "Vehicle Technology", "Vehicle Manufacturing", "Supply Chain & Logistics", "Energy & Propulsion", "Technology & Digitalization", "R&D & Innovation", "Tourism & Aviation", "Workforce & Talent"],
    ["Marketing & Sales", "Dealership & Distribution", "Vehicle Technology", "Vehicle Manufacturing", "Supply Chain & Logistics", "Energy & Propulsion", "Technology & Digitalization", "R&D & Innovation", "Workforce & Talent", "Tourism & Aviation"]
  ]
};

export const payoutMultipliers = Object.fromEntries(Object.entries(ranks).map(([industry, rounds]) => [
  industry,
  Object.fromEntries(rounds.map((parameters, roundIndex) => [roundIndex + 1, Object.fromEntries(parameters.map((parameter, rank) => [parameter, [2.7, 1.8, 1.5, 1.2, 1, 0.8, 0.7, 0.5, 0.3, 0][rank]]))]))
]));

export const datasetFor = (industry, round) => {
  const slug = industry === "Travel and Auto" ? "travel-auto" : industry.toLowerCase();
  const ext = slug === "food" && round <= 2 ? "xlsx" : "csv";
  return `./data/round-datasets/flash${round}/${slug}.${ext}`;
};
