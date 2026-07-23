# graphify — manual refresh

This folder has no `.git`, so the automatic post-commit freshness hook can't be
installed. Refresh its knowledge-graph + the federated global graph by hand:

```sh
cd "/home/dustfeather/projects/gw2"
graphify update .                                    # rebuild this graph (AST, no LLM)
graphify global add graphify-out/graph.json --as gw2  # merge into the federation
```

To re-extract with the LLM backend (richer, slower):

```sh
vault-graphify.sh --repo gw2
```

Once you `git init` here, run `vault-graphify.sh --repo gw2` once and the
post-commit hook will keep both graphs current automatically.
