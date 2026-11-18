// Optional substantive writing is an application opportunity: prepare it for
// review rather than silently omitting it. Facts and opt-ins keep their own rules.
export function shouldApproveOptionalWriting(question={}) {
 const type=question.type??question.kind;
 if(question.required||question.options?.length||!['text','textarea'].includes(type))return false;
 const label=String(question.label??question.question??'').trim();
 if(/\b(?:visa|sponsorship|citizenship|clearance|disability|gender|race|ethnicity|salary|compensation|pronouns|terminated|termination|resign|leaving|left your|references?|referral)\b/i.test(label))return false;
 return /\bwhat else should we know about you\b|\bwhy\b.*\b(?:you|us|here|join|work|interested|apply|company|role|fit)\b|^why\s+[\w& .'-]{2,80}[?!]?$|\b(?:motivat\w*|excites?|excited|achievements?|accomplishments?|proudest|proud of|challenges?|obstacles?|setbacks?|exceptional ability)\b|\b(?:describe|explain|tell|share|discuss)\b.*\b(?:projects?|contributions?|success|strengths?|experience|problems?|yourself|background)\b|\b(?:good|strong|great|best)\s+(?:fit|candidate)\b/i.test(label);
}
