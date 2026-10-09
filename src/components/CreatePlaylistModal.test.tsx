// tsc -b（npm run build）でも jest-dom のマッチャーの型を解決できるようにする（実行時の登録は vitest.setup.ts で済んでいる）
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTracksToPlaylist,
  createPlaylist,
  getCurrentUser,
  searchSpotify,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from "../api";
import CreatePlaylistModal from "./CreatePlaylistModal";

// 外部への通信（バックエンド経由の Spotify API 呼び出し）はすべてモックに差し替える
vi.mock("../api", () => ({
  getCurrentUser: vi.fn(),
  searchSpotify: vi.fn(),
  createPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));

function makeTrack(key: string, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: `track-${key}`,
    name: `曲${key}`,
    uri: `spotify:track:${key}`,
    preview_url: null,
    external_urls: { spotify: `https://open.spotify.com/track/${key}` },
    artists: [{ id: `artist-${key}`, name: `アーティスト${key}` }],
    album: { id: `album-${key}`, name: `アルバム${key}`, images: [] },
    ...overrides,
  };
}

function searchResponse(tracks: SpotifyTrack[]) {
  return { tracks: { items: tracks } };
}

/** 解決するタイミングをテスト側で決められる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const currentUser = { id: "user-1", display_name: "テストユーザー" };
const createdPlaylist: SpotifyPlaylist = {
  id: "new-playlist",
  name: "ドライブ用",
  public: false,
  tracks: { total: 0 },
  images: [],
  owner: { id: "user-1" },
};
const trackA = makeTrack("A", {
  artists: [
    { id: "artist-A", name: "アーティストA" },
    { id: "artist-X", name: "ゲストX" },
  ],
});
const trackB = makeTrack("B");

function renderModal({ isOpen = true } = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onPlaylistCreated = vi.fn();
  const ui = (open: boolean) => (
    <CreatePlaylistModal isOpen={open} onClose={onClose} onPlaylistCreated={onPlaylistCreated} />
  );
  const { container, rerender } = render(ui(isOpen));
  return { user, onClose, onPlaylistCreated, container, setOpen: (open: boolean) => rerender(ui(open)) };
}

const titleInput = () => screen.getByPlaceholderText("プレイリストのタイトルを入力");
const descriptionInput = () => screen.getByPlaceholderText("プレイリストの説明を入力（任意）");
const publicCheckbox = () => screen.getByRole("checkbox", { name: "公開プレイリストにする" });
const searchInput = () => screen.getByPlaceholderText("曲名、アーティスト名、アルバム名で検索");
const saveButton = () => screen.getByRole("button", { name: "プレイリストを保存" });

/** 見出しを含むブロック（見出しの親要素）の中に絞って探す */
function section(headingName: string) {
  return within(screen.getByRole("heading", { name: headingName }).parentElement!);
}

/** 検索語を入力して検索し、検索が終わる（ボタンが「検索中...」から戻る）まで待つ */
async function searchTracks(user: UserEvent, query = "ドライブ") {
  await user.type(searchInput(), query);
  await user.click(screen.getByRole("button", { name: "検索" }));
  await screen.findByRole("button", { name: "検索" });
}

describe("CreatePlaylistModal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(currentUser);
    vi.mocked(searchSpotify).mockResolvedValue(searchResponse([trackA, trackB]));
    vi.mocked(createPlaylist).mockResolvedValue(createdPlaylist);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({});
    // jsdom は alert を実装していないため差し替える
    vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    // Vitest の globals を有効にしていないので、Testing Library の自動クリーンアップは働かない
    cleanup();
    vi.restoreAllMocks();
  });

  describe("表示・開閉", () => {
    it("isOpen が false のときは何も表示せず、ユーザー情報も取得しない", () => {
      const { container } = renderModal({ isOpen: false });

      expect(container).toBeEmptyDOMElement();
      expect(getCurrentUser).not.toHaveBeenCalled();
    });

    it("開くとユーザー情報を取得し、空の入力フォームを表示する", () => {
      renderModal();

      expect(getCurrentUser).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { name: "新しいプレイリストを作成" })).toBeInTheDocument();
      expect(titleInput()).toHaveValue("");
      expect(descriptionInput()).toHaveValue("");
      expect(publicCheckbox()).not.toBeChecked();
      expect(searchInput()).toHaveValue("");
      expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
    });

    it("開き直すたびにユーザー情報を取得し直す", () => {
      const { setOpen } = renderModal();

      setOpen(false);
      setOpen(true);

      expect(getCurrentUser).toHaveBeenCalledTimes(2);
    });

    it.each(["×", "キャンセル"])("「%s」ボタンで閉じると、作成せずに入力内容をリセットする", async (buttonName) => {
      const { user, onClose, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");
      await user.type(descriptionInput(), "週末に聴く曲");
      await user.click(publicCheckbox());
      await searchTracks(user);
      const [addA] = section("検索結果").getAllByRole("button", { name: "追加" });
      await user.click(addA);

      await user.click(screen.getByRole("button", { name: buttonName }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onPlaylistCreated).not.toHaveBeenCalled();
      expect(createPlaylist).not.toHaveBeenCalled();
      expect(titleInput()).toHaveValue("");
      expect(descriptionInput()).toHaveValue("");
      expect(publicCheckbox()).not.toBeChecked();
      expect(searchInput()).toHaveValue("");
      expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
    });
  });

  describe("楽曲の検索", () => {
    it("検索ボタンで検索し、曲名・アーティスト・アルバムを結果に表示する", async () => {
      const { user } = renderModal();
      await user.type(searchInput(), "ドライブ");

      await user.click(screen.getByRole("button", { name: "検索" }));

      expect(searchSpotify).toHaveBeenCalledWith("ドライブ");
      await screen.findByRole("heading", { name: "検索結果" });
      const results = section("検索結果");
      expect(results.getByText("曲A")).toBeInTheDocument();
      expect(results.getByText("アーティストA, ゲストX • アルバムA")).toBeInTheDocument();
      expect(results.getByText("曲B")).toBeInTheDocument();
      expect(results.getByText("アーティストB • アルバムB")).toBeInTheDocument();
      expect(results.getAllByRole("button", { name: "追加" })).toHaveLength(2);
    });

    it("検索欄で Enter キーを押しても検索できる", async () => {
      const { user } = renderModal();

      await user.type(searchInput(), "ドライブ{Enter}");

      expect(searchSpotify).toHaveBeenCalledWith("ドライブ");
      expect(await screen.findByRole("heading", { name: "検索結果" })).toBeInTheDocument();
    });

    it("検索語が空白だけのときは検索しない", async () => {
      const { user } = renderModal();
      const searchButton = screen.getByRole("button", { name: "検索" });
      expect(searchButton).toBeDisabled();

      await user.type(searchInput(), "   {Enter}");

      expect(searchButton).toBeDisabled();
      expect(searchSpotify).not.toHaveBeenCalled();
    });

    it("検索中はボタンが「検索中...」になって押せず、終わると元に戻る", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValue(pending.promise);
      const { user } = renderModal();
      await user.type(searchInput(), "ドライブ");

      await user.click(screen.getByRole("button", { name: "検索" }));

      expect(screen.getByRole("button", { name: "検索中..." })).toBeDisabled();
      pending.resolve(searchResponse([trackA]));
      expect(await screen.findByRole("button", { name: "検索" })).toBeEnabled();
      expect(section("検索結果").getByText("曲A")).toBeInTheDocument();
    });

    it("検索に失敗したらエラーを通知する", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(searchSpotify).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user } = renderModal();

      await searchTracks(user);

      expect(window.alert).toHaveBeenCalledWith("検索に失敗しました");
      expect(consoleError).toHaveBeenCalledWith("検索エラー:", expect.any(Error));
      expect(screen.getByRole("button", { name: "検索" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
    });
  });

  describe("楽曲の選択", () => {
    it("検索結果から追加した曲は選択リストに入り、検索結果側は「追加済み」になって押せなくなる", async () => {
      const { user } = renderModal();
      await searchTracks(user);
      const [addA] = section("検索結果").getAllByRole("button", { name: "追加" });

      await user.click(addA);

      expect(addA).toHaveAccessibleName("追加済み");
      expect(addA).toBeDisabled();
      const selected = section("選択された楽曲 (1曲)");
      expect(selected.getByText("曲A")).toBeInTheDocument();
      expect(selected.queryByText("曲B")).not.toBeInTheDocument();
    });

    it("選択リストから削除した曲は、検索結果から再び追加できる", async () => {
      const { user } = renderModal();
      await searchTracks(user);
      const [addA, addB] = section("検索結果").getAllByRole("button", { name: "追加" });
      await user.click(addA);
      await user.click(addB);
      const [removeA] = section("選択された楽曲 (2曲)").getAllByRole("button", { name: "削除" });

      await user.click(removeA);

      const selected = section("選択された楽曲 (1曲)");
      expect(selected.queryByText("曲A")).not.toBeInTheDocument();
      expect(selected.getByText("曲B")).toBeInTheDocument();
      expect(addA).toHaveAccessibleName("追加");
      expect(addA).toBeEnabled();
    });

    it("検索し直しても選択済みの曲は残り、新しい検索結果でも「追加済み」と表示される", async () => {
      vi.mocked(searchSpotify)
        .mockResolvedValueOnce(searchResponse([trackA]))
        .mockResolvedValueOnce(searchResponse([trackB, trackA]));
      const { user } = renderModal();
      await searchTracks(user, "1回目");
      await user.click(section("検索結果").getByRole("button", { name: "追加" }));

      await user.clear(searchInput());
      await searchTracks(user, "2回目");

      expect(searchSpotify).toHaveBeenLastCalledWith("2回目");
      const results = section("検索結果");
      expect(results.getByText("曲B")).toBeInTheDocument();
      expect(results.getByRole("button", { name: "追加" })).toBeEnabled(); // 曲B
      expect(results.getByRole("button", { name: "追加済み" })).toBeDisabled(); // 曲A
      expect(section("選択された楽曲 (1曲)").getByText("曲A")).toBeInTheDocument();
    });
  });

  describe("プレイリストの作成", () => {
    /** count 曲を検索結果から選択した状態にし、選択した順の URI を返す */
    async function selectTracks(user: UserEvent, count: number) {
      const tracks = Array.from({ length: count }, (_, i) => makeTrack(String(i + 1)));
      vi.mocked(searchSpotify).mockResolvedValue(searchResponse(tracks));
      await searchTracks(user);
      // 100 回以上クリックするので、速さを優先して user-event ではなく fireEvent を使う
      for (const addButton of section("検索結果").getAllByRole("button", { name: "追加" })) {
        fireEvent.click(addButton);
      }
      expect(screen.getByRole("heading", { name: `選択された楽曲 (${count}曲)` })).toBeInTheDocument();
      return tracks.map((track) => track.uri);
    }

    // 100 曲以上選ぶと、クリックのたびに一覧全体が描き直されて数秒かかるため、タイムアウトを延ばす
    const manyTracksOptions = { timeout: 15_000 };

    it("タイトルが空、または空白だけのときは保存ボタンを押せない", async () => {
      const { user } = renderModal();
      expect(saveButton()).toBeDisabled();

      await user.type(titleInput(), "   ");
      expect(saveButton()).toBeDisabled();

      await user.type(titleInput(), "ドライブ用");
      expect(saveButton()).toBeEnabled();
    });

    it("入力内容でプレイリストを作成し、完了を通知して閉じる", async () => {
      const { user, onClose, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");
      await user.type(descriptionInput(), "週末に聴く曲");
      await user.click(publicCheckbox());

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", {
        name: "ドライブ用",
        description: "週末に聴く曲",
        public: true,
      });
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
      expect(window.alert).toHaveBeenCalledWith("プレイリスト「ドライブ用」を作成しました！");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(titleInput()).toHaveValue(""); // 閉じる処理で入力内容もリセットされる
    });

    it("説明文が空なら description は undefined、公開設定は既定の非公開で送る", async () => {
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", {
        name: "ドライブ用",
        description: undefined,
        public: false,
      });
    });

    it("選択した曲を、作成したプレイリストに選択した順で追加する", async () => {
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");
      await searchTracks(user);
      const [addA, addB] = section("検索結果").getAllByRole("button", { name: "追加" });
      await user.click(addB);
      await user.click(addA);

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(addTracksToPlaylist).toHaveBeenCalledWith("new-playlist", ["spotify:track:B", "spotify:track:A"]);
    });

    it("選択した曲が 100 曲ちょうどなら 1 回で追加する", manyTracksOptions, async () => {
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "たくさん");
      const uris = await selectTracks(user, 100);

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(addTracksToPlaylist).toHaveBeenCalledWith("new-playlist", uris);
    });

    it("選択した曲が 100 曲を超えると、100 曲ずつに分けて選択した順に追加する", manyTracksOptions, async () => {
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "たくさん");
      const uris = await selectTracks(user, 101);

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(2);
      expect(addTracksToPlaylist).toHaveBeenNthCalledWith(1, "new-playlist", uris.slice(0, 100));
      expect(addTracksToPlaylist).toHaveBeenNthCalledWith(2, "new-playlist", uris.slice(100));
    });

    it("作成中はボタンが「作成中...」になって押せない", async () => {
      const pending = deferred<SpotifyPlaylist>();
      vi.mocked(createPlaylist).mockReturnValue(pending.promise);
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");

      await user.click(saveButton());

      expect(screen.getByRole("button", { name: "作成中..." })).toBeDisabled();
      pending.resolve(createdPlaylist);
      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole("button", { name: "プレイリストを保存" })).toBeInTheDocument();
    });

    it("作成に失敗したらエラーを通知し、入力内容を残したまま再び保存できる状態に戻す", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(createPlaylist).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user, onClose, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");

      await user.click(saveButton());

      expect(await screen.findByRole("button", { name: "プレイリストを保存" })).toBeEnabled();
      expect(window.alert).toHaveBeenCalledWith("プレイリストの作成に失敗しました");
      expect(consoleError).toHaveBeenCalledWith("プレイリスト作成エラー:", expect.any(Error));
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
      expect(onPlaylistCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(titleInput()).toHaveValue("ドライブ用");
    });

    it("曲の追加に失敗したときもエラーを通知し、作成完了は通知しない", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(addTracksToPlaylist).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user, onClose, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");
      await searchTracks(user);
      const [addA] = section("検索結果").getAllByRole("button", { name: "追加" });
      await user.click(addA);

      await user.click(saveButton());

      expect(await screen.findByRole("button", { name: "プレイリストを保存" })).toBeEnabled();
      // プレイリスト自体は作成済みだが、画面上は作成の失敗として扱われる
      expect(createPlaylist).toHaveBeenCalledTimes(1);
      expect(window.alert).toHaveBeenCalledWith("プレイリストの作成に失敗しました");
      expect(consoleError).toHaveBeenCalledWith("プレイリスト作成エラー:", expect.any(Error));
      expect(onPlaylistCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("ユーザー情報を取得できていないときはエラーを通知し、作成しない", async () => {
      // 描画時に .catch(console.error) で参照されるため、描画より前に差し替える
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(getCurrentUser).mockRejectedValue(new Error("401 Unauthorized"));
      const { user, onPlaylistCreated } = renderModal();
      await user.type(titleInput(), "ドライブ用");

      await user.click(saveButton());

      expect(window.alert).toHaveBeenCalledWith("ユーザー情報の取得に失敗しました");
      expect(consoleError).toHaveBeenCalledWith(expect.any(Error));
      expect(createPlaylist).not.toHaveBeenCalled();
      expect(onPlaylistCreated).not.toHaveBeenCalled();
    });
  });
});
