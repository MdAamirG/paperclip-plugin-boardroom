import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage, BoardroomSidebarLink } from "../../src/ui/index.js";
import { renderWithBoardroom } from "../support/ui.js";

describe("Boardroom page (placeholder)", () => {
  it("renders under jsdom with the SDK UI hooks mocked", () => {
    const { context } = renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />);

    expect(screen.getByRole("heading", { name: "Boardroom" })).toBeInTheDocument();
    expect(context.companyId).toBeTruthy();
  });

  it("asks for a company when none is selected", () => {
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { hostContext: { companyId: null, companyPrefix: null } });

    expect(screen.getByText(/select a company/i)).toBeInTheDocument();
  });
});

describe("Boardroom sidebar entry", () => {
  it("links to the company's Boardroom route through host navigation", () => {
    renderWithBoardroom((ctx) => <BoardroomSidebarLink context={ctx} />, { hostContext: { companyPrefix: "ACME" } });

    expect(screen.getByRole("link", { name: "Boardroom" })).toHaveAttribute("href", "/ACME/boardroom");
  });
});
