import { describe, expect, it } from "vitest";
import {
  hqUrlTransportError,
  isAllowedFederationRemote,
  isLoopbackAddress,
  isPlainWsAllowedHost,
  isTailnetAddress,
  normalizeAddress,
} from "./transport-policy.js";

describe("transport-policy", () => {
  it("normalizes brackets and IPv4-mapped IPv6", () => {
    expect(normalizeAddress("[::1]")).toBe("::1");
    expect(normalizeAddress("::ffff:100.100.1.1")).toBe("100.100.1.1");
  });

  it("recognizes the tailnet ranges by IP literal only", () => {
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
    expect(isTailnetAddress("100.128.0.0")).toBe(false);
    expect(isTailnetAddress("::ffff:100.100.1.1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailnetAddress("100.300.1.1")).toBe(false);
    expect(isTailnetAddress("host.tail1234.ts.net")).toBe(false);
  });

  it("recognizes loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("LOCALHOST")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  // CC-FED-T1
  it("allows plain ws only to loopback or a tailnet IP", () => {
    expect(isPlainWsAllowedHost("100.122.174.105")).toBe(true);
    expect(isPlainWsAllowedHost("127.0.0.1")).toBe(true);
    expect(isPlainWsAllowedHost("192.168.1.10")).toBe(false);
    expect(isPlainWsAllowedHost("10.0.0.5")).toBe(false);
    expect(isPlainWsAllowedHost("hq.example.com")).toBe(false);
  });

  // CC-FED-T2
  it("accepts listener connections only from loopback or tailnet", () => {
    expect(isAllowedFederationRemote("::ffff:100.119.250.60")).toBe(true);
    expect(isAllowedFederationRemote("127.0.0.1")).toBe(true);
    expect(isAllowedFederationRemote("::ffff:192.168.0.20")).toBe(false);
    expect(isAllowedFederationRemote(undefined)).toBe(false);
  });

  // CC-FED-T1 / T3
  it("explains why an HQ URL is rejected", () => {
    expect(hqUrlTransportError("ws://100.122.174.105:11112")).toBeNull();
    expect(hqUrlTransportError("wss://hq.example.com/federation/ws")).toBeNull();
    expect(hqUrlTransportError("http://100.122.174.105:11112")).toMatch(/ws:\/\/ or wss:\/\//);
    expect(hqUrlTransportError("ws://hq.example.com:11112")).toMatch(/wss/);
    expect(hqUrlTransportError("not a url")).toMatch(/valid/);
  });
});
