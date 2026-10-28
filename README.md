# HWPX 보고서 뷰어

한글(.hwpx) 보고서를 휴대폰에서 한글 프로그램과 같은 줄 배치로 보는 뷰어입니다.
휴대폰에 한컴 글꼴이 없어 생기는 줄 어긋남을 막기 위해, 한컴 글꼴의 글자 폭 자료로 줄 바꿈·쪽 나눔 위치를 계산하고
비슷한 무료 글꼴로 그립니다.

- 주소: https://wnsdudkk-ux.github.io/hwpx-viewer/
- 안드로이드(크롬): 주소를 열고 화면 위의 **설치** 단추나 크롬 메뉴의 **앱 설치**를 누릅니다.
- 아이폰(사파리): 주소를 열고 **공유** 단추 → **홈 화면에 추가**를 누릅니다.

설치하면 한 번 연 뒤로는 인터넷 없이도 열립니다. 안드로이드에서는 카카오톡·메일 등의 **공유** 메뉴로 .hwpx 파일을 뷰어에 넘길 수 있습니다.
문서 파일은 기기 안에서만 읽고 어디로도 보내지 않습니다. 최근에 연 문서 12개는 그 기기의 브라우저 저장 공간에만 남습니다.

## 한계

- 줄 위치는 한글에 맞추지만 글자 모양(획)은 한컴 글꼴과 조금 다릅니다. 결재 전 최종 확인은 한글 프로그램에서 해 주세요.
- 예전 형식(.hwp)은 열지 않습니다. 한글에서 .hwpx로 저장한 파일만 엽니다.
- 한자 등 드물게 쓰는 글자는 기기에 있는 글꼴로 그립니다.

## 사용한 자료와 저작권

- 글자 폭 자료와 줄·쪽 배치 규칙: [python-hwpx](https://pypi.org/project/python-hwpx/) 6.10.0에서 옮김 — Apache License 2.0 (`licenses/python-hwpx-LICENSE.txt`, `licenses/python-hwpx-NOTICE.txt`)
- 글꼴: 나눔명조·나눔고딕(© NHN Corporation)에서 필요한 글자만 담아 이름을 HwpxViewer Myeongjo·HwpxViewer Gothic으로 바꾼 판, 본고딕(Noto Sans KR) — SIL Open Font License 1.1 (`licenses/OFL-*.txt`)
- 압축 풀기: [JSZip](https://stuk.github.io/jszip/) 3.10.1 — MIT (`licenses/jszip-LICENSE.md`)
