import { describe, expect, it } from "vitest";
import { LICENSE_FILE, licenseFromText } from "../src/profile/license.ts";

describe("licenseFromText", () => {
  it("recognises common licenses from their opening text", () => {
    expect(licenseFromText("MIT License\n\nCopyright (c) 2024\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software")).toBe("MIT");
    expect(licenseFromText("                                 Apache License\n                           Version 2.0, January 2004")).toBe("Apache-2.0");
    expect(licenseFromText("Mozilla Public License Version 2.0\n==================================")).toBe("MPL-2.0");
    expect(licenseFromText("GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007")).toBe("GPL-3.0");
    expect(licenseFromText("Redistribution and use in source and binary forms, with or without modification, are permitted provided that... 3. Neither the name of the copyright holder")).toBe("BSD-3-Clause");
    expect(licenseFromText("Some proprietary text")).toBeUndefined();
  });

  it("matches license file names including suffixed variants", () => {
    for (const n of ["LICENSE", "LICENSE.md", "COPYING", "COPYING.MPL2", "LICENSE-MIT", "UNLICENSE"]) expect(LICENSE_FILE.test(n), n).toBe(true);
    expect(LICENSE_FILE.test("licenses.py")).toBe(false);
  });
});
