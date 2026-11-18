import type { DealInput, DraftContext, Drafts, Verdict } from '../types';

const sourceLine = (citation: string): string => `Rule source: ${citation}`;

export function buildDrafts(input: DealInput, verdict: Verdict, ctx: DraftContext): Drafts {
  const requestedDiscount = String(input.requestedDiscountPct);
  const counterDiscount = String(verdict.counterDiscountPct);
  const qty = String(input.qty);
  const source = sourceLine(ctx.citation);
  let buyerReply: string;

  if (verdict.badge === 'MARGIN BREACH') {
    const pendingParagraph =
      verdict.partnerPendingDiscountPct === null
        ? ''
        : `\n\nIf you can move up a volume tier above ${qty} units, I may be able to get ${String(verdict.partnerPendingDiscountPct)}% approved - that is above my standard cap and needs a sign-off on my side.`;
    buyerReply = `Hi ${ctx.buyerName},\n\nThanks for the offer on ${qty} x ${ctx.skuName} (${ctx.ventureName}). We can't go that far on price - ${requestedDiscount}% takes us below our cost line. What I can confirm right away is ${counterDiscount}% off.${pendingParagraph}\n\n${source}`;
  } else if (verdict.badge === 'PARTNER SIGN-OFF NEEDED') {
    buyerReply = `Hi ${ctx.buyerName},\n\nGood news on ${qty} x ${ctx.skuName}: ${requestedDiscount}% works on margin, but anything past ${String(input.discountCapPct)}% needs a partner sign-off on our side. I can lock in ${counterDiscount}% right now, and I am asking ${ctx.partnerName ?? 'my partner'} to approve ${requestedDiscount}% - will confirm as soon as I can.\n\n${source}`;
  } else {
    buyerReply = `Hi ${ctx.buyerName},\n\nConfirmed: ${requestedDiscount}% off ${qty} x ${ctx.skuName} for ${ctx.ventureName}. All good on our side.\n\n${source}`;
  }

  let partnerMessage: string | null = null;
  if (
    ctx.partnerName !== null &&
    (verdict.badge === 'PARTNER SIGN-OFF NEEDED' || verdict.partnerPendingDiscountPct !== null)
  ) {
    if (verdict.badge === 'PARTNER SIGN-OFF NEEDED') {
      partnerMessage = `${ctx.partnerName}, quick one: buyer wants ${requestedDiscount}% on ${qty} x ${ctx.skuName} (${ctx.ventureName}). Margin comes out at ${String(verdict.requestedMarginPct)}%, which clears our ${String(input.marginFloorPct)}% floor, but it is past the ${String(input.discountCapPct)}% cap so it needs your OK. I have offered ${counterDiscount}% in the meantime - can you sign off on ${String(verdict.partnerPendingDiscountPct)}%?\n\n${source}`;
    } else {
      partnerMessage = `${ctx.partnerName}, heads up: buyer is asking ${requestedDiscount}% on ${qty} x ${ctx.skuName} (${ctx.ventureName}). That breaches our ${String(input.marginFloorPct)}% floor. I am countering at ${counterDiscount}%. If we go up a volume tier I can safely offer ${String(verdict.partnerPendingDiscountPct)}%, but that is past my ${String(input.discountCapPct)}% cap so I need your sign-off first.\n\n${source}`;
    }
  }

  return { buyerReply, partnerMessage };
}
