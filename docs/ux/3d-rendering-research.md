# 3D 렌더링 폴리시 리서치

**검토일:** 2026-08-24
**제품 기준:** 첫 3초에는 완성도 높은 장면으로 읽히고, 50분 집중 + 10분 휴식 동안은 시각적으로 피로하지 않아야 한다.

## 조사 범위

Exa로 30개 연구 축에서 518개 검색 결과 후보를 검토했다. 이 수치는 중복을 포함한 검색 결과 검토량이며, 구현 근거에는 원 논문, 저자·기관 배포 자료, 정부 기술 매뉴얼, three.js·WebGL 공식 문서만 남겼다. 블로그 요약, 제품 홍보성 라운드업, 출처를 재인용한 글은 제외했다.

## 채택한 설계

### 바다

대양 전체를 Navier–Stokes, SPH 또는 얕은물 격자로 직접 계산하면 이 앱의 넓은 수면과 모바일 WebGL 예산을 동시에 만족시키기 어렵다. 대신 다음을 결합한다.

- 6방향 중력파 스펙트럼: 양방향 30°/−40°/49°/−44° 장·중파 4개는 Gerstner/trochoidal 메시 변위, 메시 해상도보다 짧은 2개는 5방향 fragment normal 전용
- offshore 고정 주파수와 유한수심 파수: `ω² = gk tanh(kh)`를 기준으로, 해안과 나란한 파수를 보존하고 해안 법선 방향은 누적 eikonal 위상으로 적분해 얕은 곳에서 파장을 줄임
- 해안 굴절, shoaling, 수심의 0.34로 총 기하 파고를 제한하는 breaker limiter, 파형과 같은 위상 gradient를 쓰는 법선, Jacobian 압축 기반 whitecap, 분리된 swash ribbon
- Schlick Fresnel `F0=0.0204`, bounded GGX 반사, Beer–Lambert RGB 흡수, 얕은 물 caustic 근사

이 구조는 대규모 수면에서 표면 파동 모델이 CFD/SPH와 상호 보완적이라고 설명한 [Tessendorf](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf), 실시간 대수면에 높이장·입자·소규모 파를 결합한 [Chentanez와 Muller](https://matthias-research.github.io/pages/publications/hfFluid.pdf), 지형 경계를 만족시키는 절차적 파동을 다룬 [Jeschke 등](https://pub.ista.ac.at/~chafner/JeschkeWaveCages.pdf)을 따른다. 유한수심 파수는 [Fenton의 dispersion 근사 정리](https://johndfenton.com/Papers/Dispersion-Relation.pdf), 쇄파 한계와 shoaling은 [USACE Coastal Engineering Manual](https://www.publications.usace.army.mil/USACE-Publications/Engineer-Manuals/u43544q/636F617374616C20656E67696E656572696E67206D616E75616C/)을 기준으로 삼았다.

### 하늘과 구름

하늘은 한 장의 색 그라데이션이 아니라 시선·태양 방향에 따라 달라지는 각도 구조가 필요하다.

- Rayleigh 위상, Henyey–Greenstein Mie 위상, Kasten–Young 공기질량을 기존 시간대 팔레트와 결합
- civil twilight의 태양 방향 따뜻한 띠, 반대편 Belt of Venus와 Earth shadow, 야간 airglow
- 시간에 따라 흔들리지 않는 interleaved-gradient dither로 어두운 그라데이션 밴딩 억제
- 밀도·pseudo-height normal 아틀라스를 사용하는 3개 InstancedMesh 구름층과 인스턴스당 4-slice 얇은 볼륨 셰
- 층별 시차, Beer–Lambert 감쇠, 인접 profile 혼합, 전·후면 self-shadow, 낮은 태양의 silver lining

물리 기준은 [Preetham daylight model](https://dl.acm.org/doi/10.1145/311535.311545), [Bruneton의 multiple-scattering 연구와 검증 구현](https://ebruneton.github.io/precomputed_atmospheric_scattering/), [Hosek–Wilkie sky model](https://cgg.mff.cuni.cz/projects/SkylightModelling/HosekWilkie_SkylightModel_SIGGRAPH2012_Preprint.pdf), [three.js Sky 공식 구현](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/objects/Sky.js)을 교차 확인했다. 구름 조명과 형태는 Guerrilla의 [Horizon cloud system](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn), [Nubis](https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf), Frostbite의 [physically based sky and clouds](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf)를 참고했다.

진짜 volumetric raymarch는 자유 비행 카메라에서 더 정확하지만, 이 앱의 고정 카메라·고해상도 후처리·모바일 예산에는 지속 비용이 크다. 따라서 현재는 조명 가능한 4-layer volumetric impostor를 사용한다. 512×64 POT 아틀라스는 페이지 시작 시 한 번만 생성하며, 구름 이동 주기는 약 38분~3시간으로 유지한다.

### 도시, 숲, 후처리

- 도시는 매스 → setback/crown → 5개 건축·재질 family → landmark detail 순으로 생성하고, 창·가로등·가로수·벤치·주차 차량은 instancing한다.
- 숲은 6/5/4단 수관 LOD, 가장자리 hero tree, instanced understory, 절차적 바닥 albedo/bump로 구성한다.
- 후처리는 OutputPass에서 ACES와 sRGB 변환을 한 번만 수행한다. 블룸·빛줄기·비네트·그레인은 밤에도 작은 광원만 강조하도록 제한한다.

구현 경계는 [three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html), [MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html), [UnrealBloomPass](https://threejs.org/docs/pages/UnrealBloomPass.html), [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)를 따른다. 식생 계층은 [Weber와 Penn의 나무 생성 모델](https://history.siggraph.org/learning/creation-and-rendering-of-realistic-trees-by-weber-and-penn/), 건축 계층은 [Muller 등의 procedural building model](https://peterwonka.net/Publications/pdfs/2006.SG.Mueller.ProceduralModelingOfBuildings.final.pdf)을 참고했다.

## 60분 체류 규칙

- 중앙 타이머 통로에서는 구름 밀도와 바다 normal·foam·glitter를 낮춘다.
- 반복이 쉽게 보이는 이동은 수십 분 단위로 늦추고, 짧은 점멸은 작고 희소하게 유지한다.
- `prefers-reduced-motion`에서는 파도·구름·새·입자·점멸의 장식 시간을 정지한다. 구현은 [W3C SCR40](https://www.w3.org/WAI/WCAG22/Techniques/client-side-script/SCR40)의 사용자 선호 감지 원칙을 따른다.
- stage는 `vh`를 하위 호환 fallback으로 두고 `dvh`를 우선해, 모바일 주소창이 열리거나 닫혀도 실제 가시 높이·원·캔버스가 함께 조정되게 한다. 데스크톱도 전체 가시 viewport를 사용해 비표준 화면비에서 검은 레터박스를 만들지 않는다.
- 낮에는 하늘과 안개가 장면을 하얗게 압축하지 않도록 하고, 밤에는 블랙 크러시 때문에 지면 디테일이 사라지지 않도록 한다.
- 셰이더와 인스턴스 업데이트는 매 프레임 새 Three.js 객체를 만들지 않는다.

## 명시적 기술 한계

- 바다는 volumetric CFD·Boussinesq·FFT 해양 해석이 아니라, 선형 유한수심 파동을 실시간 Gerstner 변위와 결합한 분석적 하이브리드다.
- 해안 법선 파수는 렌더 수심 범위에서 full dispersion 대비 8.5% 이내로 맞춘 해석 근사다. 대신 위상의 미분과 surface tangent·normal은 같은 식을 사용해 서로 어괋나지 않는다.
- caustic은 광자 추적이 아닌 얕은 물 전용 투영 근사다.
- 구름은 4-layer volumetric impostor라 현재 고정 카메라에는 시차와 자체 음영을 주지만, 자유 비행 카메라용 체적 raymarch 구조는 아니다.
- 절차적 도시는 사진 기반 디지털 트윈이 아니며, 숲은 고용량 스캔 모델 대신 스타일화된 LOD 구조를 사용한다.
