import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

describe("createTelegramSendChatActionHandler", () => {
  const make401Error = () => new Error("401 Unauthorized");
  const make500Error = () => new Error("500 Internal Server Error");

  let nowMs = 1_000_000;
  let dateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowMs = 1_000_000;
    dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it("calls sendChatActionFn on success", async () => {
    const fn = vi.fn().mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
    });

    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledWith(123, "typing", undefined);
    expect(handler.isSuspended()).toBe(false);
  });

  it("skips calls during backoff window (does not block)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
    });

    // First call fails with 401 — sets backoff deadline
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call during backoff window: skips immediately (no throw, no API call)
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(1); // not called again
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("backoff window"));
    expect(handler.isSuspended()).toBe(false);
  });

  it("retries after backoff window expires", async () => {
    const fn = vi.fn().mockRejectedValueOnce(make401Error()).mockResolvedValueOnce(undefined);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
    });

    // First call: 401
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");

    // Advance time past the backoff window
    nowMs += 5_000;

    // Second call: backoff expired → retries and succeeds
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
    expect(handler.isSuspended()).toBe(false);
  });

  it("suspends after maxConsecutive401 actual failures", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    // Simulate 3 failures with time advancing past the backoff between each
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    nowMs += 5_000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    nowMs += 10_000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));

    // Subsequent calls are silently skipped
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(3); // not called again
  });

  it("resets failure counter on success", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw make401Error();
      }
      return Promise.resolve(true);
    });
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    // Advance past backoff
    nowMs += 5_000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    // Advance past backoff again
    nowMs += 10_000;
    // Third call succeeds
    await handler.sendChatAction(123, "typing");

    expect(handler.isSuspended()).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });

  it("does not count non-401 errors toward suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make500Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");

    expect(handler.isSuspended()).toBe(false);
  });

  it("reset() clears suspension and backoff state", async () => {
    const fn = vi.fn().mockRejectedValueOnce(make401Error()).mockResolvedValueOnce(undefined);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 1,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);

    handler.reset();
    expect(handler.isSuspended()).toBe(false);

    // Call should now go through (no skip, no suspension)
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is shared across multiple chatIds (global handler)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    // Different chatIds all contribute to the same failure counter
    await expect(handler.sendChatAction(111, "typing")).rejects.toThrow("401");
    nowMs += 5_000;
    await expect(handler.sendChatAction(222, "typing")).rejects.toThrow("401");
    nowMs += 10_000;
    await expect(handler.sendChatAction(333, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    // Suspended for all chats
    await handler.sendChatAction(444, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
