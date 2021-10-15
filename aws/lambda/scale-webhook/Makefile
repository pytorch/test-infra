.PHONY: deployment
deployment: deployment.zip

deployment.zip:
	yarn install && yarn dist

clean:
	$(RM) -r deployment.zip dist/
