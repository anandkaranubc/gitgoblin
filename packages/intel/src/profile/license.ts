/** SPDX identifier guessed from the text of a LICENSE or COPYING file, for forges without a license API. */
export function licenseFromText(text: string): string | undefined {
  const head = text.slice(0, 4000);
  const rules: [RegExp, string][] = [
    [/Apache License\s+Version 2\.0/i, "Apache-2.0"],
    [/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i, "MPL-2.0"],
    [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, "AGPL-3.0"],
    [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, "LGPL-3.0"],
    [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i, "LGPL-2.1"],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
    [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
    [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, "MIT"],
    [/Redistribution and use in source and binary forms[\s\S]{0,600}Neither the name/i, "BSD-3-Clause"],
    [/Redistribution and use in source and binary forms/i, "BSD-2-Clause"],
    [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
    [/Boost Software License\s*-\s*Version 1\.0/i, "BSL-1.0"],
    [/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i, "ISC"],
    [/Creative Commons Attribution 4\.0|CC BY 4\.0/i, "CC-BY-4.0"],
    [/CC0 1\.0 Universal/i, "CC0-1.0"],
    [/European Union Public Licence\s+V\.?\s*1\.2/i, "EUPL-1.2"],
    [/Eclipse Public License[\s-]{0,6}v?[ \t]{0,3}2\.0/i, "EPL-2.0"],
    [/zlib License|This software is provided 'as-is', without any express or implied warranty/i, "Zlib"],
  ];
  for (const [re, id] of rules) if (re.test(head)) return id;
  return undefined;
}

export const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING|UNLICENSE)([._-][\w.-]+)?$/i;
