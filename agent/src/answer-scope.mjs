// "related" only counts as kinship when it is "related to" someone: Amazon's screening question "Do you have experience
// in Design/Innovation, research & development, manufacturing, process, industrial engineering, or related work?"
// (16221, lesson 472) matched "related ... work" and took his no-connections default (No) over the approved Yes.
export function connectionQuestion(label) {
 const q=String(label);
 if(/government|public (?:body|institution)|political/i.test(q))return false;
 return /\b(?:know|knowing)\b.*\b(?:anyone|someone|people|employees?)\b|\b(?:friends?|relatives?|related to|family|personal (?:connections?|relationships?))\b.*\b(?:employ|work|company|us|organization)\b|\b(?:referred|referral)\b.*\b(?:employee|friend|relative|staffing|agency)\b|\b(?:employee|staffing|agency)\b.*\b(?:referral|referred)\b|\b(?:were|have|are) you\b.*\breferred\b/i.test(q);
}
