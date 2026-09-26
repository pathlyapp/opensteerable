from scripts.check_public_exposure import joined, literal_exposure_failures


def test_public_landing_page_may_name_products() -> None:
    text = f"{joined('a', 'roli')} · {joined('e', 'town')}"
    assert literal_exposure_failures("docs/index.md", text) == []


def test_product_names_remain_private_outside_allowlisted_docs() -> None:
    product = joined("a", "roli")
    assert literal_exposure_failures("README.md", product) == [
        f"README.md: contains private product literal {product!r}"
    ]


def test_allowlisted_docs_still_reject_sensitive_literals() -> None:
    home = joined("/Users/", "wangtai")
    assert literal_exposure_failures("docs/index.md", home) == [
        f"docs/index.md: contains banned public literal {home!r}"
    ]
