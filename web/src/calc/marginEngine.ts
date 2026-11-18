import type { DealInput, Verdict } from '../types';

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const TOLERANCE = 1e-9;

export function evaluateDeal(input: DealInput): Verdict {
  const notes: string[] = [];
  let dReqFrac = input.requestedDiscountPct / 100;

  if (input.requestedDiscountPct >= 100) {
    dReqFrac = 0.9999;
    notes.push('Requested discount was invalid and has been clamped to 99.99%.');
  } else if (input.requestedDiscountPct < 0) {
    dReqFrac = 0;
    notes.push('Requested discount was below zero and has been clamped to 0%.');
  }

  const mMinFrac = input.marginFloorPct / 100;
  const dCapFrac = input.discountCapPct === null ? null : input.discountCapPct / 100;
  const requestedNetUnitPrice = input.listPrice * (1 - dReqFrac);
  const requestedMarginFrac = (requestedNetUnitPrice - input.cogs) / requestedNetUnitPrice;
  const totalProfit = (requestedNetUnitPrice - input.cogs) * input.qty;
  const denominator = input.listPrice * (1 - mMinFrac);
  const dSafe = denominator <= 0 ? 0 : 1 - input.cogs / denominator;
  const safeDiscountFrac = Math.max(0, dSafe);
  const requestedMarginPct = round2(requestedMarginFrac * 100);

  let badge: Verdict['badge'];
  let maxSafeDiscountPct: number;
  let counterDiscountPct: number;
  let partnerPendingDiscountPct: number | null;

  if (input.cogs >= input.listPrice) {
    badge = 'MARGIN BREACH';
    maxSafeDiscountPct = round2(0);
    counterDiscountPct = round2(0);
    partnerPendingDiscountPct = null;
    notes.push('COGS is at or above list price, so no discount can be profitable.');
    notes.push(`Requested margin is ${requestedMarginPct}% versus the ${round2(input.marginFloorPct)}% floor.`);
    notes.push('Maximum safe discount is 0%.');
  } else if (requestedMarginFrac < mMinFrac - TOLERANCE) {
    badge = 'MARGIN BREACH';
    maxSafeDiscountPct = round2(safeDiscountFrac * 100);
    const counterFrac = dCapFrac === null ? safeDiscountFrac : Math.min(safeDiscountFrac, dCapFrac);
    counterDiscountPct = round2(counterFrac * 100);
    partnerPendingDiscountPct =
      dCapFrac !== null && dSafe > dCapFrac + TOLERANCE ? round2(dSafe * 100) : null;
    notes.push(`Requested margin is ${requestedMarginPct}% versus the ${round2(input.marginFloorPct)}% floor.`);
    notes.push(`Maximum safe discount is ${maxSafeDiscountPct}%.`);
    if (partnerPendingDiscountPct !== null) {
      notes.push(`${partnerPendingDiscountPct}% exceeds the cap and needs partner sign-off.`);
    }
  } else if (
    dCapFrac !== null &&
    dReqFrac > dCapFrac + TOLERANCE &&
    input.requiresPartnerApproval
  ) {
    badge = 'PARTNER SIGN-OFF NEEDED';
    maxSafeDiscountPct = round2(safeDiscountFrac * 100);
    counterDiscountPct = round2(dCapFrac * 100);
    partnerPendingDiscountPct = round2(input.requestedDiscountPct);
    notes.push(`Requested margin of ${requestedMarginPct}% clears the ${round2(input.marginFloorPct)}% floor.`);
    notes.push(`Requested discount exceeds the ${round2(dCapFrac * 100)}% cap.`);
    notes.push(`Immediate counter-offer is ${counterDiscountPct}%; the requested discount awaits sign-off.`);
  } else {
    badge = 'APPROVED';
    maxSafeDiscountPct = round2(safeDiscountFrac * 100);
    counterDiscountPct = round2(input.requestedDiscountPct);
    partnerPendingDiscountPct = null;
    if (dCapFrac !== null && dReqFrac > dCapFrac + TOLERANCE) {
      notes.push('The request crosses the cap, but no partner approval rule applies.');
    } else {
      notes.push('The request stays within the cap or is cap-free for a solo venture.');
    }
    notes.push(`Requested margin of ${requestedMarginPct}% stays at or above the ${round2(input.marginFloorPct)}% floor.`);
  }

  const counterRequiresApproval =
    input.discountCapPct !== null && counterDiscountPct > input.discountCapPct;

  return {
    badge,
    requestedNetUnitPrice: round2(requestedNetUnitPrice),
    requestedMarginPct,
    totalProfit: round2(totalProfit),
    maxSafeDiscountPct,
    counterDiscountPct,
    counterRequiresApproval,
    partnerPendingDiscountPct,
    notes,
  };
}
