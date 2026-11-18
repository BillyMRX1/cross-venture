import { describe, expect, it } from 'vitest';
import { evaluateDeal } from './marginEngine';
import type { DealInput } from '../types';

function deal(overrides: Partial<DealInput> = {}): DealInput {
  return {
    listPrice: 100,
    cogs: 40,
    marginFloorPct: 55,
    discountCapPct: 10,
    requiresPartnerApproval: true,
    requestedDiscountPct: 20,
    qty: 30,
    ...overrides,
  };
}

describe('evaluateDeal', () => {
  it('identifies a margin breach and a capped pending discount', () => {
    const verdict = evaluateDeal(deal());
    expect(verdict.badge).toBe('MARGIN BREACH');
    expect(verdict.requestedNetUnitPrice).toBe(80);
    expect(verdict.requestedMarginPct).toBe(50);
    expect(verdict.totalProfit).toBe(1200);
    expect(verdict.maxSafeDiscountPct).toBe(11.11);
    expect(verdict.counterDiscountPct).toBe(10);
    expect(verdict.counterRequiresApproval).toBe(false);
    expect(verdict.partnerPendingDiscountPct).toBe(11.11);
    expect(verdict.notes.length).toBeGreaterThan(0);
  });

  it('uses the safe discount as the solo venture counter-offer', () => {
    const verdict = evaluateDeal(
      deal({
        listPrice: 250,
        cogs: 90,
        marginFloorPct: 55,
        discountCapPct: null,
        requiresPartnerApproval: false,
        requestedDiscountPct: 25,
        qty: 8,
      }),
    );
    expect(verdict.badge).toBe('MARGIN BREACH');
    expect(verdict.requestedNetUnitPrice).toBe(187.5);
    expect(verdict.requestedMarginPct).toBe(52);
    expect(verdict.totalProfit).toBe(780);
    expect(verdict.maxSafeDiscountPct).toBe(20);
    expect(verdict.counterDiscountPct).toBe(20);
    expect(verdict.counterRequiresApproval).toBe(false);
    expect(verdict.partnerPendingDiscountPct).toBe(null);
  });

  it('marks a margin-safe request over the cap for partner sign-off', () => {
    const verdict = evaluateDeal(
      deal({
        marginFloorPct: 40,
        requestedDiscountPct: 12,
        qty: 20,
      }),
    );
    expect(verdict.badge).toBe('PARTNER SIGN-OFF NEEDED');
    expect(verdict.requestedNetUnitPrice).toBe(88);
    expect(verdict.requestedMarginPct).toBe(54.55);
    expect(verdict.totalProfit).toBe(960);
    expect(verdict.maxSafeDiscountPct).toBe(33.33);
    expect(verdict.counterDiscountPct).toBe(10);
    expect(verdict.counterRequiresApproval).toBe(false);
    expect(verdict.partnerPendingDiscountPct).toBe(12);
  });

  it('approves a request within the cap that maintains the margin floor', () => {
    const verdict = evaluateDeal(
      deal({
        requestedDiscountPct: 5,
      }),
    );
    expect(verdict.badge).toBe('APPROVED');
    expect(verdict.requestedNetUnitPrice).toBe(95);
    expect(verdict.requestedMarginPct).toBe(57.89);
    expect(verdict.totalProfit).toBe(1650);
    expect(verdict.maxSafeDiscountPct).toBe(11.11);
    expect(verdict.counterDiscountPct).toBe(5);
    expect(verdict.counterRequiresApproval).toBe(false);
    expect(verdict.partnerPendingDiscountPct).toBe(null);
  });

  it('forces a breach when cogs are at or above list price', () => {
    const verdict = evaluateDeal(
      deal({
        cogs: 110,
        requestedDiscountPct: 10,
        qty: 5,
      }),
    );
    expect(verdict.badge).toBe('MARGIN BREACH');
    expect(verdict.maxSafeDiscountPct).toBe(0);
    expect(verdict.counterDiscountPct).toBe(0);
    expect(verdict.requestedNetUnitPrice).toBe(90);
    expect(verdict.totalProfit).toBe(-100);
    expect(verdict.notes.join(' ').toLowerCase()).toContain('cogs');
    expect(verdict.partnerPendingDiscountPct).toBe(null);
  });

  it('flags a counter-offer over the cap when no partner rule applies', () => {
    const verdict = evaluateDeal(
      deal({
        cogs: 20,
        marginFloorPct: 40,
        requiresPartnerApproval: false,
        requestedDiscountPct: 12,
        qty: 5,
      }),
    );
    expect(verdict.badge).toBe('APPROVED');
    expect(verdict.counterDiscountPct).toBe(12);
    expect(verdict.counterRequiresApproval).toBe(true);
    expect(verdict.partnerPendingDiscountPct).toBe(null);
    expect(verdict.requestedMarginPct).toBe(77.27);
  });

  it('clamps a requested discount of 100 percent or more', () => {
    const verdict = evaluateDeal(deal({ requestedDiscountPct: 150 }));
    expect(verdict.requestedNetUnitPrice).toBe(0.01);
    expect(verdict.notes.join(' ')).toContain('99.99');
  });
});
