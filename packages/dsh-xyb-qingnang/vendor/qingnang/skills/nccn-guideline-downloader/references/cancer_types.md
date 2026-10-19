# NCCN 65 种癌种列表

内置于 `scripts/download_nccn.py` 的 `CANCER_TYPE_FILTERS`，支持中英文关键词自动匹配。

## 快速索引（常用癌种）

| 中文 | 英文关键词 | 癌种 Key |
|------|-----------|---------|
| 乳腺癌 | breast, breast cancer | `breast_cancer` |
| 肺癌 | lung, nsclc, sclc | `non_small_cell_lung_cancer`, `small_cell_lung_cancer` |
| 胰腺癌 | pancreatic, pancreas | `pancreatic_adenocarcinoma` |
| 结肠癌 | colon | `colon_cancer` |
| 直肠癌 | rectal, rectum | `rectal_cancer` |
| 胃癌 | gastric, stomach | `gastric_cancer` |
| 肝癌 | hcc, liver, hepatocellular | `hepatocellular_carcinoma` |
| 前列腺癌 | prostate | `prostate_cancer` |
| 卵巢癌 | ovarian | `ovarian_cancer` |
| 甲状腺癌 | thyroid | `thyroid_carcinoma` |
| 宫颈癌 | cervical | `cervical_cancer` |
| 肾癌 | kidney, renal | `kidney_cancer` |
| 膀胱癌 | bladder | `bladder_cancer` |
| 黑色素瘤 | melanoma | `melanoma_cutaneous` |
| 多发性骨髓瘤 | myeloma | `multiple_myeloma` |

## 全部 65 种癌种

1. 急性淋巴细胞白血病 (ALL) — `acute_lymphoblastic_leukemia`
2. 急性髓系白血病 (AML) — `acute_myeloid_leukemia`
3. 壶腹腺癌 — `ampullary_adenocarcinoma`
4. 肛门癌 — `anal_carcinoma`
5. 阑尾肿瘤 — `appendiceal_neoplasms`
6. 基底细胞皮肤癌 — `basal_cell_skin_cancer`
7. B细胞淋巴瘤 — `b_cell_lymphomas`
8. 胆道癌 — `biliary_tract_cancers`
9. 膀胱癌 — `bladder_cancer`
10. 骨癌 — `bone_cancer`
11. 乳腺癌 — `breast_cancer`
12. 卡斯尔曼病 — `castleman_disease`
13. 中枢神经系统肿瘤 — `central_nervous_system_cancers`
14. 宫颈癌 — `cervical_cancer`
15. 慢性淋巴细胞白血病 (CLL/SLL) — `chronic_lymphocytic_leukemia`
16. 慢性髓系白血病 (CML) — `chronic_myeloid_leukemia`
17. 结肠癌 — `colon_cancer`
18. 皮肤淋巴瘤 — `cutaneous_lymphomas`
19. 隆突性皮肤纤维肉瘤 — `dermatofibrosarcoma_protuberans`
20. 食管癌/食管胃结合部癌 — `esophageal_cancers`
21. 胃癌 — `gastric_cancer`
22. 胃肠道间质瘤 (GIST) — `gastrointestinal_stromal_tumors`
23. 妊娠滋养细胞肿瘤 — `gestational_trophoblastic_neoplasia`
24. 毛细胞白血病 — `hairy_cell_leukemia`
25. 头颈癌 — `head_and_neck_cancers`
26. 肝胆癌 — `hepatobiliary_cancers`
27. 肝细胞癌 (HCC) — `hepatocellular_carcinoma`
28. 组织细胞肿瘤 — `histiocytic_neoplasms`
29. 霍奇金淋巴瘤 — `hodgkin_lymphoma`
30. 卡波西肉瘤 — `kaposi_sarcoma`
31. 肾癌 — `kidney_cancer`
32. 皮肤黑色素瘤 — `melanoma_cutaneous`
33. 葡萄膜黑色素瘤 — `melanoma_uveal`
34. 默克尔细胞癌 — `merkel_cell_carcinoma`
35. 腹膜间皮瘤 — `mesothelioma_peritoneal`
36. 胸膜间皮瘤 — `mesothelioma_pleural`
37. 多发性骨髓瘤 — `multiple_myeloma`
38. 骨髓增生异常综合征 (MDS) — `myelodysplastic_syndromes`
39. 髓系/淋系肿瘤 — `myeloid_lymphoid_neoplasms`
40. 骨髓增殖性肿瘤 (MPN) — `myeloproliferative_neoplasms`
41. 神经母细胞瘤 — `neuroblastoma`
42. 神经内分泌和肾上腺肿瘤 — `neuroendocrine_adrenal_tumors`
43. 非小细胞肺癌 (NSCLC) — `non_small_cell_lung_cancer`
44. 隐匿性原发癌 — `occult_primary`
45. 卵巢癌/输卵管癌/腹膜癌 — `ovarian_cancer`
46. 胰腺腺癌 — `pancreatic_adenocarcinoma`
47. 儿童急性淋巴细胞白血病 — `pediatric_all`
48. 儿童侵袭性成熟B细胞淋巴瘤 — `pediatric_b_cell_lymphoma`
49. 儿童中枢神经系统肿瘤 — `pediatric_cns`
50. 儿童霍奇金淋巴瘤 — `pediatric_hodgkin`
51. 儿童软组织肉瘤 — `pediatric_soft_tissue_sarcoma`
52. 阴茎癌 — `penile_cancer`
53. 前列腺癌 — `prostate_cancer`
54. 直肠癌 — `rectal_cancer`
55. 小肠腺癌 — `small_bowel_adenocarcinoma`
56. 小细胞肺癌 (SCLC) — `small_cell_lung_cancer`
57. 软组织肉瘤 — `soft_tissue_sarcoma`
58. 鳞状细胞皮肤癌 — `squamous_cell_skin_cancer`
59. 系统性轻链淀粉样变性 — `systemic_light_chain_amyloidosis`
60. 系统性肥大细胞增多症 — `systemic_mastocytosis`
61. T细胞淋巴瘤 — `t_cell_lymphomas`
62. 睾丸癌 — `testicular_cancer`
63. 胸腺瘤和胸腺癌 — `thymomas_thymic`
64. 甲状腺癌 — `thyroid_carcinoma`
65. 子宫肿瘤/子宫内膜癌 — `uterine_neoplasms`
66. 阴道癌 — `vaginal_cancer`
67. 外阴癌 — `vulvar_cancer`
68. 华氏巨球蛋白血症 — `waldenstrom_macroglobulinemia`
69. 肾母细胞瘤 (Wilms) — `wilms_tumor`

## 关键词匹配机制

输入任意别名（中文或英文）会自动扩展为该癌种的全部别名：

- 输入 `胰腺` → 扩展为 `["pancreatic adenocarcinoma", "pancreatic", "pancreas", "胰腺腺癌", "胰腺癌", "胰腺"]`
- 输入 `lung` → 扩展为 NSCLC + SCLC 的全部别名
- 输入 `乳腺` → 扩展为 `["breast cancer", "breast", "乳腺癌", "乳腺"]`
