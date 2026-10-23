Since 9.2, `@retry` returns the `_RetryDecorated` Protocol (#601). Pyright now reports `reportIncompatibleMethodOverride` on each `@retry` method that overrides a base-class method. Runtime behavior is correct, and mypy (`--strict`) reports no error. 9.1.4 gave no error, because there `retry` kept the type of the decorated function.

**Reproduction** (pyright 1.1.414, tenacity `main` at 32ac68f):

```python
import abc

from tenacity import retry, stop_after_attempt


class Base(abc.ABC):
    @abc.abstractmethod
    def compute(self, x: int) -> int: ...


class Impl(Base):
    @retry(stop=stop_after_attempt(3))
    def compute(self, x: int) -> int:
        return x
```

```
repro.py:13:9 - error: "compute" overrides method of same name in class "Base" with incompatible type "_RetryDecorated[(self: Impl, x: int), int]" (reportIncompatibleMethodOverride)
```

An `async def` override gives the same error.

**Cause.** When a base method is overridden by something that is not a function, pyright reports this error without comparing the two types. We tried a Protocol whose `__call__` and `__get__` match the base method exactly, and pyright rejects it too. It also rejects `functools.cache` in the same position. So no change to `_RetryDecorated` can fix this, and #668 and #759 do not change it. The pyright maintainer treats this as designed behavior (microsoft/pyright#10502). Pyright accepts only a plain `Callable` return type, but that type cannot carry the typed `.retry`, `.statistics` and `.retry_with` from #601.

**Possible directions:**
1. Document the limitation and the `# pyright: ignore[reportIncompatibleMethodOverride]` workaround.
2. Add an opt-in variant, for example `retry_method(...)`, that returns `Callable[P, R]`. It is for methods that override a base method, and it gives up the typed attributes for those methods only.
3. Leave it to pyright. We can open a request there to compare callable-object overrides through `__get__`.

Which direction do you prefer? We can send a PR for 1 or 2, with tests and a release note.

Context: we hit this on a codebase with 18 `@retry` overrides of abstract repository and client methods, so we are holding tenacity at 9.1 for now.

