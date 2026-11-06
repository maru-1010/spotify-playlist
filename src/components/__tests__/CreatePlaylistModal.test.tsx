/**
 * CreatePlaylistModal（新しいプレイリストを作る画面）のテスト
 *
 * テストケースは「同値分割」と「境界値分析」で洗い出した。
 *   - isOpen .............. true（表示する） / false（何も表示しない）
 *   - タイトル（前後の空白を除いた文字数）
 *       無効: 0文字（未入力・半角空白・全角空白・タブだけ）   有効: 1文字以上
 *       境界値: 0文字 / 1文字   極端な値: 10,000文字・絵文字・記号
 *   - 説明文 .............. 空（送らない） / 入力あり（そのまま送る）
 *   - 公開チェック ........ OFF（初期値・public: false） / ON（public: true）
 *   - ユーザー情報 ........ 取得できた / 取得に失敗した / 取得待ち
 *   - 検索語（前後の空白を除いた文字数）   無効: 0文字   有効: 1文字以上
 *   - 検索結果の件数 ...... 0件（一覧を出さない） / 1件以上
 *   - 選んだ曲の数（100曲ずつ追加APIを呼ぶ）
 *       0曲（呼ばない） / 1〜100曲（1回） / 101〜200曲（2回） / 201曲〜（3回）
 *       境界値: 0, 1, 99, 100, 101, 200, 201
 *   - API の結果 .......... 成功 / 失敗 / 応答待ち（二重送信の防止）
 *
 * 外部への通信（../../api の関数）はすべてモックにしている。
 * 仕様が決まっていない点や、今の動きが本来と食い違って見える点は、今の動きを正としてテストで固めない。
 * それらは it.todo（仕様の確認待ち）と it.skip（不具合の疑い。skip を外すと今は失敗する）で残した。
 */
import "@testing-library/jest-dom/vitest"; // npm run build（tsc）でも jest-dom の型を使えるようにするため
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  addTracksToPlaylist,
  createPlaylist,
  getCurrentUser,
  searchSpotify,
  type SpotifyPlaylist,
  type SpotifyTrack,
  type SpotifyUser,
} from "../../api";
import CreatePlaylistModal from "../CreatePlaylistModal";
import {
  chunk,
  deferred,
  makePlaylist,
  makeTrack,
  makeTracks,
  parentOf,
  rowOf,
  searchResponse,
} from "./testUtils";

// 外部への通信はすべてモックにする（api.ts の関数を差し替える）
vi.mock("../../api", () => ({
  getCurrentUser: vi.fn(),
  searchSpotify: vi.fn(),
  createPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));

const USER: SpotifyUser = { id: "user-1", display_name: "テストユーザー" };
const CREATED_PLAYLIST: SpotifyPlaylist = makePlaylist({ id: "new-playlist", name: "作成済み" });

let alertMock: Mock<(message?: unknown) => void>;
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(searchSpotify).mockResolvedValue(searchResponse([]));
  vi.mocked(createPlaylist).mockResolvedValue(CREATED_PLAYLIST);
  vi.mocked(addTracksToPlaylist).mockResolvedValue({});
  alertMock = vi.fn<(message?: unknown) => void>();
  vi.stubGlobal("alert", alertMock);
  // 念のため、モック漏れで本当に通信しようとしたら分かるようにする
  fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error("テスト中に実際の通信をしようとしました")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  const fetchCalls = fetchMock.mock.calls.length;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  expect(fetchCalls, "実際の通信（fetch）が呼ばれた").toBe(0);
});

// ---------- テスト用の手順・部品 ----------

/** モックの API が返した Promise の続き（state の更新）を act の中で反映させる */
async function flushPromises() {
  await act(async () => {});
}

async function renderModal({ isOpen = true }: { isOpen?: boolean } = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onPlaylistCreated = vi.fn();
  const ui = (open: boolean) => (
    <CreatePlaylistModal isOpen={open} onClose={onClose} onPlaylistCreated={onPlaylistCreated} />
  );
  const view = render(ui(isOpen));
  await flushPromises();
  /** 親が isOpen を true にしたときの状態にする */
  const open = async () => {
    view.rerender(ui(true));
    await flushPromises();
  };
  /** 親がいったん閉じて（isOpen=false）、また開いたときの状態にする */
  const reopen = async () => {
    view.rerender(ui(false));
    await open();
  };
  return { user, onClose, onPlaylistCreated, open, reopen, container: view.container };
}

const titleInput = () => screen.getByPlaceholderText("プレイリストのタイトルを入力");
const descriptionInput = () => screen.getByPlaceholderText("プレイリストの説明を入力（任意）");
const publicCheckbox = () => screen.getByRole("checkbox", { name: "公開プレイリストにする" });
const searchInput = () => screen.getByPlaceholderText("曲名、アーティスト名、アルバム名で検索");
// 曲が数百行ある画面では getByRole が1回約1秒かかるため、ボタンは表示されている文字で探す
const searchButton = () => screen.getByText(/^検索(中\.\.\.)?$/, { selector: "button" });
const saveButton = () => screen.getByText(/^(プレイリストを保存|作成中\.\.\.)$/, { selector: "button" });
const resultsSection = () => parentOf(screen.getByText("検索結果", { selector: "h4" }));
const selectedSection = () => parentOf(screen.getByText(/^選択された楽曲/, { selector: "h4" }));
const resultRow = (track: SpotifyTrack) => rowOf(within(resultsSection()).getByText(track.name));
const selectedRow = (track: SpotifyTrack) => rowOf(within(selectedSection()).getByText(track.name));

/** 検索語を入れて「検索」を押し、検索が終わるまで待つ */
async function searchFor(user: UserEvent, query: string, results: SpotifyTrack[]) {
  vi.mocked(searchSpotify).mockResolvedValueOnce(searchResponse(results));
  await user.clear(searchInput());
  await user.type(searchInput(), query);
  await user.click(searchButton());
  await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
}

/** 検索結果の「追加」を押して、曲を選ぶ */
async function addFromResults(user: UserEvent, track: SpotifyTrack) {
  await user.click(within(resultRow(track)).getByRole("button", { name: "追加" }));
}

/**
 * 曲をまとめて選ぶ（境界値のテストで数百曲を選ぶための準備）。
 * 実際の検索API（1回20件）と同じく20曲ずつ検索して、検索結果の曲をすべて「追加」する。
 * 準備の手順なので、速い fireEvent で操作する。
 */
async function selectAll(tracks: SpotifyTrack[]) {
  for (const [page, pageTracks] of chunk(tracks, 20).entries()) {
    vi.mocked(searchSpotify).mockResolvedValueOnce(searchResponse(pageTracks));
    fireEvent.change(searchInput(), { target: { value: `まとめて ${page + 1}` } });
    await act(async () => {
      fireEvent.click(searchButton());
    });
    for (const button of within(resultsSection()).getAllByText("追加")) {
      fireEvent.click(button);
    }
  }
}

// ---------- テスト ----------

describe("CreatePlaylistModal", () => {
  describe("開閉（isOpen: true / false）", () => {
    it("isOpen が false のときは何も表示せず、ユーザー情報も取得しない", async () => {
      const { container } = await renderModal({ isOpen: false });

      expect(container).toBeEmptyDOMElement();
      expect(getCurrentUser).not.toHaveBeenCalled();
    });

    it("isOpen が true のときは空の入力欄で表示し、保存・検索ボタンは押せない。ユーザー情報を1回取得する", async () => {
      await renderModal();

      expect(screen.getByRole("heading", { name: "新しいプレイリストを作成" })).toBeInTheDocument();
      expect(titleInput()).toHaveValue("");
      expect(descriptionInput()).toHaveValue("");
      expect(publicCheckbox()).not.toBeChecked();
      expect(searchInput()).toHaveValue("");
      expect(saveButton()).toBeDisabled();
      expect(searchButton()).toBeDisabled();
      expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
      expect(getCurrentUser).toHaveBeenCalledTimes(1);
    });

    it("閉じた状態から開いたときに、ユーザー情報を取得する", async () => {
      const { open } = await renderModal({ isOpen: false });

      await open();

      expect(titleInput()).toBeInTheDocument();
      expect(getCurrentUser).toHaveBeenCalledTimes(1);
    });
  });

  describe("タイトルと保存ボタン（前後の空白を除いて 0文字＝押せない / 1文字以上＝押せる）", () => {
    it.each([
      { label: "半角空白1文字", value: " " },
      { label: "半角空白3文字", value: "   " },
      { label: "全角空白1文字", value: "　" },
      { label: "タブ1文字", value: "\t" },
      { label: "半角空白・全角空白・タブの混在", value: " 　\t " },
    ])("空白だけ（$label）のときは保存ボタンが押せない", async ({ value }) => {
      const { user } = await renderModal();

      await user.click(titleInput());
      await user.paste(value);

      expect(titleInput()).toHaveValue(value);
      expect(saveButton()).toBeDisabled();
    });

    it.each([
      { label: "半角1文字（下限）", value: "a" },
      { label: "全角1文字", value: "あ" },
      { label: "絵文字1文字", value: "🎵" },
      { label: "前後に空白がある", value: "  a  " },
      // 文字数の上限は仕様の確認待ち（今は画面側で制限していない）。上限を決めたらこのケースを見直す
      { label: "10,000文字（極端に長い）", value: "あ".repeat(10_000) },
    ])("$label のときは保存ボタンが押せる", async ({ value }) => {
      const { user } = await renderModal();

      await user.click(titleInput());
      await user.paste(value);

      expect(saveButton()).toBeEnabled();
    });

    it("1文字入れてから消す（1文字→0文字）と、保存ボタンは押せない状態に戻る", async () => {
      const { user } = await renderModal();

      await user.type(titleInput(), "a");
      expect(saveButton()).toBeEnabled();

      await user.type(titleInput(), "{Backspace}");
      expect(titleInput()).toHaveValue("");
      expect(saveButton()).toBeDisabled();
    });
  });

  describe("プレイリストの作成（送る内容）", () => {
    it("タイトルだけで保存すると、取得したユーザーIDで「非公開・説明なし」で作り、曲の追加APIは呼ばない（0曲）", async () => {
      const { user, onClose, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledTimes(1);
      expect(createPlaylist).toHaveBeenCalledWith("user-1", {
        name: "朝の音楽",
        description: undefined,
        public: false,
      });
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
      expect(alertMock).toHaveBeenCalledWith("プレイリスト「朝の音楽」を作成しました！");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("説明文を入れると、その説明文を送る", async () => {
      const { user, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.type(descriptionInput(), "通勤で聴く曲");
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", {
        name: "朝の音楽",
        description: "通勤で聴く曲",
        public: false,
      });
    });

    it("公開にチェックすると public: true を送る", async () => {
      const { user, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.click(publicCheckbox());
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", expect.objectContaining({ public: true }));
    });

    it("公開のチェックを付けてから外すと public: false を送る", async () => {
      const { user, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.click(publicCheckbox());
      await user.click(publicCheckbox());
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", expect.objectContaining({ public: false }));
    });

    it.each([
      // 文字数の上限は仕様の確認待ち（今は画面側で制限していない）。上限を決めたらこのケースを見直す
      { label: "10,000文字", value: "あ".repeat(10_000) },
      { label: "記号や HTML のような文字列", value: `<b>"Rock" & 'Roll'</b> #1 100%` },
      { label: "絵文字だけ", value: "🎵🎸🥁" },
    ])("タイトルが$label でも、変えずにそのまま送る", async ({ value }) => {
      const { user, onPlaylistCreated } = await renderModal();

      await user.click(titleInput());
      await user.paste(value);
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(createPlaylist).toHaveBeenCalledWith("user-1", expect.objectContaining({ name: value }));
      expect(alertMock).toHaveBeenCalledWith(`プレイリスト「${value}」を作成しました！`);
    });

    it("作成に成功したあと開き直すと、入力・検索結果・選んだ曲は初期状態に戻っている", async () => {
      const track = makeTrack("A");
      const { user, onPlaylistCreated, reopen } = await renderModal();
      await user.type(titleInput(), "朝の音楽");
      await user.type(descriptionInput(), "説明");
      await user.click(publicCheckbox());
      await searchFor(user, "song", [track]);
      await addFromResults(user, track);

      await user.click(saveButton());
      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      await reopen();

      expect(titleInput()).toHaveValue("");
      expect(descriptionInput()).toHaveValue("");
      expect(publicCheckbox()).not.toBeChecked();
      expect(searchInput()).toHaveValue("");
      expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
    });
  });

  describe("作成中（応答待ち）", () => {
    it("作成APIの応答を待つ間は「作成中...」と表示してボタンを押せなくし、もう一度押しても二重に作らない", async () => {
      const pending = deferred<SpotifyPlaylist>();
      vi.mocked(createPlaylist).mockReturnValueOnce(pending.promise);
      const { user, onPlaylistCreated } = await renderModal();
      await user.type(titleInput(), "朝の音楽");

      await user.click(saveButton());

      expect(saveButton()).toHaveTextContent("作成中...");
      expect(saveButton()).toBeDisabled();
      await user.click(saveButton());
      expect(createPlaylist).toHaveBeenCalledTimes(1);
      expect(onPlaylistCreated).not.toHaveBeenCalled();

      await act(async () => pending.resolve(CREATED_PLAYLIST));

      expect(onPlaylistCreated).toHaveBeenCalledTimes(1);
      expect(createPlaylist).toHaveBeenCalledTimes(1);
    });
  });

  describe("ユーザー情報（取得できた / 失敗した / 取得待ち）", () => {
    it("ユーザー情報の取得に失敗していると、保存を押しても作成APIを呼ばず「ユーザー情報の取得に失敗しました」と知らせる", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error("401 Unauthorized"));
      const { user, onClose, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.click(saveButton());

      expect(alertMock).toHaveBeenCalledWith("ユーザー情報の取得に失敗しました");
      expect(createPlaylist).not.toHaveBeenCalled();
      expect(onPlaylistCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(titleInput()).toHaveValue("朝の音楽");
      expect(errorSpy).toHaveBeenCalled();
    });

    it("ユーザー情報の取得を待っている間に保存を押しても、作成APIは呼ばない", async () => {
      vi.mocked(getCurrentUser).mockReturnValueOnce(new Promise<SpotifyUser>(() => {}));
      const { user, onPlaylistCreated } = await renderModal();

      await user.type(titleInput(), "朝の音楽");
      await user.click(saveButton());

      // このとき出すメッセージ（今は「取得に失敗しました」）は仕様の確認待ちのため確かめない
      expect(createPlaylist).not.toHaveBeenCalled();
      expect(onPlaylistCreated).not.toHaveBeenCalled();
    });
  });

  describe("作成の失敗", () => {
    it("プレイリスト作成APIが失敗したら「プレイリストの作成に失敗しました」と知らせ、入力を残したまま閉じない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(createPlaylist).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const track = makeTrack("A");
      const { user, onClose, onPlaylistCreated } = await renderModal();
      await searchFor(user, "song", [track]);
      await addFromResults(user, track);
      await user.type(titleInput(), "朝の音楽");

      await user.click(saveButton());

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("プレイリストの作成に失敗しました"));
      await waitFor(() => expect(saveButton()).toHaveTextContent("プレイリストを保存"));
      expect(saveButton()).toBeEnabled();
      expect(addTracksToPlaylist).not.toHaveBeenCalled();
      expect(onPlaylistCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(titleInput()).toHaveValue("朝の音楽");
      expect(selectedRow(track)).toBeInTheDocument();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("曲の追加APIが失敗したら、成功のメッセージは出さず「作成中...」も解除する", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(addTracksToPlaylist).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const track = makeTrack("A");
      const { user } = await renderModal();
      await searchFor(user, "song", [track]);
      await addFromResults(user, track);
      await user.type(titleInput(), "朝の音楽");

      await user.click(saveButton());

      await waitFor(() => expect(addTracksToPlaylist).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(saveButton()).toHaveTextContent("プレイリストを保存"));
      expect(alertMock).not.toHaveBeenCalledWith(expect.stringContaining("を作成しました"));
      // プレイリスト自体はできているため、出すメッセージ・一覧の再読み込み・再試行の扱いは仕様の確認待ち
    });
  });

  describe("選んだ曲の追加（100曲ずつに分けて送る）", () => {
    // 数百曲を画面で選ぶため時間がかかる（1件あたり数秒）。負荷が高いときに落ちないよう制限時間を長めにしている
    it.each([
      { count: 0, sizes: [] as number[], label: "呼ばない" },
      { count: 1, sizes: [1], label: "1回（1曲）" },
      { count: 99, sizes: [99], label: "1回（99曲）" },
      { count: 100, sizes: [100], label: "1回（100曲）" },
      { count: 101, sizes: [100, 1], label: "2回（100曲＋1曲）" },
      { count: 200, sizes: [100, 100], label: "2回（100曲＋100曲）" },
      { count: 201, sizes: [100, 100, 1], label: "3回（100曲＋100曲＋1曲）" },
    ])(
      "$count 曲を選んで保存すると、曲の追加APIは $label",
      { timeout: 60_000 },
      async ({ count, sizes }) => {
        const tracks = makeTracks(count);
        const { user, onPlaylistCreated } = await renderModal();
        if (count > 0) {
          await selectAll(tracks);
          expect(screen.getByText(`選択された楽曲 (${count}曲)`)).toBeInTheDocument();
        }
        await user.type(titleInput(), "まとめて追加");

        await user.click(saveButton());

        await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
        const calls = vi.mocked(addTracksToPlaylist).mock.calls;
        expect(calls.map(([, uris]) => uris.length)).toEqual(sizes);
        // 作成したプレイリストへ、全曲を漏れなく・重複なく・選んだ順に送っている
        expect(calls).toEqual(
          chunk(
            tracks.map((track) => track.uri),
            100,
          ).map((uris) => ["new-playlist", uris]),
        );
      },
    );

    it("曲は検索結果の並びではなく、選んだ順番どおりに送る", async () => {
      const [first, second, third] = makeTracks(3);
      const { user, onPlaylistCreated } = await renderModal();
      await searchFor(user, "song", [first, second, third]);
      await addFromResults(user, third);
      await addFromResults(user, first);
      await addFromResults(user, second);
      await user.type(titleInput(), "朝の音楽");

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(addTracksToPlaylist).toHaveBeenCalledWith("new-playlist", [third.uri, first.uri, second.uri]);
    });

    it("101曲のとき、1回目（100曲）の追加が終わるまで2回目（1曲）を送らない（曲の順番を保つ）", { timeout: 60_000 }, async () => {
      const tracks = makeTracks(101);
      const firstBatch = deferred<unknown>();
      vi.mocked(addTracksToPlaylist).mockReturnValueOnce(firstBatch.promise);
      const { user, onPlaylistCreated } = await renderModal();
      await selectAll(tracks);
      await user.type(titleInput(), "まとめて追加");

      await user.click(saveButton());

      await waitFor(() => expect(addTracksToPlaylist).toHaveBeenCalledTimes(1));
      await flushPromises();
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(onPlaylistCreated).not.toHaveBeenCalled();

      await act(async () => firstBatch.resolve({}));

      await waitFor(() => expect(onPlaylistCreated).toHaveBeenCalledTimes(1));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(2);
      expect(vi.mocked(addTracksToPlaylist).mock.calls[1]).toEqual(["new-playlist", [tracks[100].uri]]);
    });
  });

  describe("曲の検索", () => {
    it.each([
      { label: "未入力（0文字）", value: "" },
      { label: "半角空白だけ", value: "   " },
      { label: "全角空白だけ", value: "　" },
    ])("検索語が$label のときは検索ボタンが押せず、Enter でも検索しない", async ({ value }) => {
      const { user } = await renderModal();

      await user.click(searchInput());
      if (value) await user.paste(value);

      expect(searchButton()).toBeDisabled();
      await user.keyboard("{Enter}");
      expect(searchSpotify).not.toHaveBeenCalled();
    });

    it("1文字（下限）の検索語で「検索」を押すと、その語で検索する", async () => {
      const { user } = await renderModal();

      await user.type(searchInput(), "a");
      expect(searchButton()).toBeEnabled();
      await user.click(searchButton());

      await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
      expect(searchSpotify).toHaveBeenCalledTimes(1);
      expect(searchSpotify).toHaveBeenCalledWith("a");
    });

    it("Enter キーで検索でき、Enter 以外のキー入力では検索しない", async () => {
      const { user } = await renderModal();

      await user.type(searchInput(), "beatles");
      expect(searchSpotify).not.toHaveBeenCalled();

      await user.keyboard("{Enter}");

      await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
      expect(searchSpotify).toHaveBeenCalledTimes(1);
      expect(searchSpotify).toHaveBeenCalledWith("beatles");
    });

    it("記号を含む検索語も、変えずにそのまま検索APIへ渡す", async () => {
      const query = "AC/DC & Queen #1 100%?";
      const { user } = await renderModal();

      await searchFor(user, query, []);

      expect(searchSpotify).toHaveBeenCalledWith(query);
    });

    it("検索中は「検索中...」と表示してボタンを押せなくし、終わると元に戻る", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValueOnce(pending.promise);
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles");

      await user.click(searchButton());

      expect(searchButton()).toHaveTextContent("検索中...");
      expect(searchButton()).toBeDisabled();

      await act(async () => pending.resolve(searchResponse([makeTrack("A")])));

      expect(searchButton()).toHaveTextContent(/^検索$/);
      expect(searchButton()).toBeEnabled();
      expect(within(resultsSection()).getByText("Song A")).toBeInTheDocument();
    });

    it("検索結果が0件のときは、結果の行（「追加」ボタン）を出さない", async () => {
      const { user } = await renderModal();

      await searchFor(user, "該当なし", []);

      // 0件のときに何を表示するか（今は何も表示しない）は仕様の確認待ちのため、結果の行が無いことだけを確かめる
      expect(searchSpotify).toHaveBeenCalledWith("該当なし");
      expect(screen.queryByRole("button", { name: "追加" })).not.toBeInTheDocument();
    });

    it("検索結果には、曲名・アーティスト（複数は「, 」区切り）・アルバム名と「追加」ボタンを、返ってきた順に出す", async () => {
      const single = makeTrack("A");
      const multi = makeTrack("B", {
        artists: [
          { id: "b1", name: "Artist B1" },
          { id: "b2", name: "Artist B2" },
        ],
      });
      const { user } = await renderModal();

      await searchFor(user, "song", [single, multi]);

      const section = resultsSection();
      expect(within(section).getAllByText(/^Song /).map((element) => element.textContent)).toEqual([
        "Song A",
        "Song B",
      ]);
      expect(within(section).getByText("Artist A • Album A")).toBeInTheDocument();
      expect(within(section).getByText("Artist B1, Artist B2 • Album B")).toBeInTheDocument();
      expect(within(section).getAllByRole("button", { name: "追加" })).toHaveLength(2);
    });

    it("検索し直すと、前の検索結果は新しい結果に置き換わる", async () => {
      const { user } = await renderModal();

      await searchFor(user, "first", [makeTrack("A"), makeTrack("B")]);
      await searchFor(user, "second", [makeTrack("C")]);

      expect(searchSpotify).toHaveBeenLastCalledWith("second");
      expect(within(resultsSection()).queryByText("Song A")).not.toBeInTheDocument();
      expect(within(resultsSection()).queryByText("Song B")).not.toBeInTheDocument();
      expect(within(resultsSection()).getByText("Song C")).toBeInTheDocument();
    });

    it("検索に失敗したら「検索に失敗しました」と知らせ、ボタンを元に戻す", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(searchSpotify).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles");

      await user.click(searchButton());

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("検索に失敗しました"));
      await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
      expect(searchButton()).toBeEnabled();
      expect(errorSpy).toHaveBeenCalled();
    });

    // 最終報告「4. 食い違って見える点」を参照。skip を外すと今は失敗する（検索APIが2回呼ばれる）
    it.skip("【不具合の疑い】検索中は Enter キーでも検索し直さない（ボタンを押せないのと揃える）", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValueOnce(pending.promise);
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles{Enter}");
      expect(searchButton()).toHaveTextContent("検索中...");

      await user.keyboard("{Enter}");

      expect(searchSpotify).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(searchResponse([])));
    });
  });

  describe("曲の選択（追加・削除・同じ曲の重複防止）", () => {
    it("「追加」を押すと選んだ曲の一覧に入り（1曲）、その曲のボタンは「追加済み」になって押せない", async () => {
      const a = makeTrack("A");
      const b = makeTrack("B");
      const { user } = await renderModal();
      await searchFor(user, "song", [a, b]);

      await addFromResults(user, a);

      expect(screen.getByRole("heading", { name: "選択された楽曲 (1曲)" })).toBeInTheDocument();
      expect(within(selectedRow(a)).getByText("Artist A • Album A")).toBeInTheDocument();
      expect(within(resultRow(a)).getByRole("button", { name: "追加済み" })).toBeDisabled();
      expect(within(resultRow(b)).getByRole("button", { name: "追加" })).toBeEnabled();
    });

    it("同じ曲は2回選べない（検索し直して同じ曲が出てきても「追加済み」のまま）", async () => {
      const a = makeTrack("A");
      const b = makeTrack("B");
      const { user } = await renderModal();
      await searchFor(user, "first", [a]);
      await addFromResults(user, a);

      await searchFor(user, "second", [b, a]);
      const addedButton = within(resultRow(a)).getByRole("button", { name: "追加済み" });
      expect(addedButton).toBeDisabled();
      await user.click(addedButton);

      expect(screen.getByRole("heading", { name: "選択された楽曲 (1曲)" })).toBeInTheDocument();
      expect(within(selectedSection()).getAllByText("Song A")).toHaveLength(1);
      expect(within(resultRow(b)).getByRole("button", { name: "追加" })).toBeEnabled();
    });

    it("選んだ曲を「削除」すると一覧から外れ、検索結果の「追加」がまた押せる。0曲になると一覧ごと表示しない（2曲→1曲→0曲）", async () => {
      const a = makeTrack("A");
      const b = makeTrack("B");
      const { user } = await renderModal();
      await searchFor(user, "song", [a, b]);
      await addFromResults(user, a);
      await addFromResults(user, b);
      expect(screen.getByRole("heading", { name: "選択された楽曲 (2曲)" })).toBeInTheDocument();

      await user.click(within(selectedRow(a)).getByRole("button", { name: "削除" }));

      expect(screen.getByRole("heading", { name: "選択された楽曲 (1曲)" })).toBeInTheDocument();
      expect(within(selectedSection()).queryByText("Song A")).not.toBeInTheDocument();
      expect(within(selectedSection()).getByText("Song B")).toBeInTheDocument();
      expect(within(resultRow(a)).getByRole("button", { name: "追加" })).toBeEnabled();

      await user.click(within(selectedRow(b)).getByRole("button", { name: "削除" }));

      expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
      expect(within(resultRow(b)).getByRole("button", { name: "追加" })).toBeEnabled();
    });
  });

  describe("閉じる・キャンセル", () => {
    it.each([{ button: "×" }, { button: "キャンセル" }])(
      "「$button」で閉じると onClose を1回だけ呼び、作成はしない。開き直すと入力・検索結果・選んだ曲は初期状態",
      async ({ button }) => {
        const track = makeTrack("A");
        const { user, onClose, onPlaylistCreated, reopen } = await renderModal();
        await user.type(titleInput(), "途中まで入力");
        await user.type(descriptionInput(), "説明");
        await user.click(publicCheckbox());
        await searchFor(user, "song", [track]);
        await addFromResults(user, track);

        await user.click(screen.getByRole("button", { name: button }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPlaylistCreated).not.toHaveBeenCalled();
        expect(createPlaylist).not.toHaveBeenCalled();

        await reopen();

        expect(titleInput()).toHaveValue("");
        expect(descriptionInput()).toHaveValue("");
        expect(publicCheckbox()).not.toBeChecked();
        expect(searchInput()).toHaveValue("");
        expect(screen.queryByRole("heading", { name: "検索結果" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /^選択された楽曲/ })).not.toBeInTheDocument();
      },
    );
  });

  // 仕様が決まっていないため、今の動きを正としてテストにしていない点（最終報告「3. 仕様の確認が要る点」を参照）
  describe("仕様の確認が要る点", () => {
    it.todo("タイトル・検索語の前後の空白を取り除いて送るか（今は入力のまま送る）");
    it.todo("タイトル・説明文の文字数の上限（今は画面側で制限していない）");
    it.todo("空白だけの説明文を「説明なし」として扱うか（今は空白のまま送る）");
    it.todo("ユーザー情報の取得待ち・取得失敗を、いつ・どう知らせるか（今は保存を押したときに「取得に失敗しました」）");
    it.todo("曲の追加が途中で失敗したときの扱い（プレイリストはできている。メッセージ・一覧の再読み込み・再試行での二重作成）");
    it.todo("検索結果が0件のときの表示（今は何も表示しない）");
  });
});
