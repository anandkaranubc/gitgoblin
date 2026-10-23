### Have you read the Troubleshooting section?

Yes

### Plugin version

7.16.2

### ESLint version

10.12.0

### Node.js version

22.23.1

### Bug description

The autofix seems to work line by line.
When the `waitFor` callback is on the same line as the test, the fix produces broken code, or ESLint crashes.

### Steps to reproduce

1. Run `eslint --fix` on:

   ```js
   test('submits', async () => { await waitFor(() => { fireEvent.click(button); }); });
   ```

   One fix pass replaces the `waitFor` statement with the text of the whole test:

   ```js
   test('submits', async () => { test('submits', async () => { await waitFor(() => { fireEvent.click(button); }); }); });
   ```

   Each next fix pass nests it further.

2. Run `eslint` (no `--fix` needed) on a line with both a side effect and an assertion:

   ```js
   test('submits', async () => { await waitFor(() => { fireEvent.click(button); expect(spy).toHaveBeenCalled(); }); });
   ```

### Error output/screenshots

```
Error: Fix objects must not be overlapped in a report.
Rule: "testing-library/no-wait-for-side-effects"
```

### ESLint configuration

```js
import testingLibrary from 'eslint-plugin-testing-library';

export default [
  {
    plugins: {'testing-library': testingLibrary},
    rules: {'testing-library/no-wait-for-side-effects': 'error'},
  },
];
```

### Rule(s) affected

`no-wait-for-side-effects`

### Anything else?

The same code split over several lines is fixed correctly.

### Do you want to submit a pull request to fix this bug?

Yes
