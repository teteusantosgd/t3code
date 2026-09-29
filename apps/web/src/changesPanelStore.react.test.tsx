import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { selectThreadChangesPanelState, useChangesPanelStore } from "./changesPanelStore";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  useChangesPanelStore.setState({ byThreadKey: {} });
});

it("renders and updates the Changes panel selection without an update loop", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  function Selection() {
    const panel = useChangesPanelStore((state) =>
      selectThreadChangesPanelState(state.byThreadKey, threadRef),
    );
    return <span>{panel.listLayout}</span>;
  }

  await act(() => {
    renderer = create(<Selection />);
  });
  expect(renderer?.toJSON()).toMatchObject({ children: ["list"] });

  await act(() => {
    useChangesPanelStore.getState().setListLayout(threadRef, "tree");
  });
  expect(renderer?.toJSON()).toMatchObject({ children: ["tree"] });
});
