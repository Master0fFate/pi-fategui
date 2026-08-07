import { Target } from 'lucide-react';
import type { GoalMaxChildAssignment } from '../../../shared/contracts/goalmaxxing';

export interface GoalMaxAgentLink {
  assignment: GoalMaxChildAssignment;
  criterionTitles: string[];
}

function markerLabel(link: GoalMaxAgentLink): string {
  const criteria = link.assignment.criterionIds.length;
  return `Goal-linked ${link.assignment.lane} agent · ${criteria} ${criteria === 1 ? 'criterion' : 'criteria'} · ${link.assignment.evidenceIds.length} evidence`;
}

export function GoalMaxAgentMarker({ link }: { link: GoalMaxAgentLink }) {
  const label = markerLabel(link);
  const title = link.criterionTitles.length ? `${label}\n${link.criterionTitles.slice(0, 4).join('\n')}` : label;
  return <span className="goalmax-agent-marker" aria-label={label} title={title}><Target size={10} aria-hidden="true" /></span>;
}

export function GoalMaxAssignmentScope({ link }: { link: GoalMaxAgentLink }) {
  const criteria = link.assignment.criterionIds.length;
  return (
    <section className="goalmax-assignment-scope" aria-label="Goal assignment">
      <Target size={13} aria-hidden="true" />
      <span><strong>{link.assignment.lane} lane</strong><small>{criteria} {criteria === 1 ? 'criterion' : 'criteria'} · {link.assignment.evidenceIds.length} evidence</small></span>
    </section>
  );
}
